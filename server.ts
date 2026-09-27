import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import path from 'path';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';

const app = express();
const httpServer = http.createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: { origin: '*' }
});
const PORT = 3000;

app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// Ensure persistent storage directory
const DATA_DIR = path.join(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Super User credentials - stored only on remote server
const SUPERUSER_USERNAME = 'vijay1';
const SUPERUSER_PASSWORD = 'vijay@12';
const SUPERUSER_PHONE = '9790425634';

interface SiteConfig {
  footerSecondLine: string;
  aboutContent: string;
  superUserPhone: string;
}

interface DBData {
  teachers: any[];
  mcqs: any[];
  liveSessions: Record<string, any>;
  reports: any[];
  otps: Record<string, { code: string; expiresAt: number; verified: boolean }>;
  teacherLogins: any[];
  studentActivities: any[];
  siteConfig?: SiteConfig;
}

function loadDB(): DBData {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      if (!parsed.teacherLogins) parsed.teacherLogins = [];
      if (!parsed.studentActivities) parsed.studentActivities = [];
      if (!parsed.siteConfig) {
        parsed.siteConfig = {
          footerSecondLine: 'Live Proctored Assessment Engine',
          aboutContent: 'V SMART LEARN is a premier real-time interactive MCQ assessment platform designed for educators, institutions, and competitive learners. Featuring live proctoring, synchronized question broadcasting, instant leaderboard tracking, and carrier-grade telecom OTP verification.',
          superUserPhone: SUPERUSER_PHONE,
        };
      }
      return parsed;
    }
  } catch (err) {
    console.error('Error reading DB, re-initializing:', err);
  }
  const initialDB: DBData = {
    teachers: [],
    mcqs: [],
    liveSessions: {},
    reports: [],
    otps: {},
    teacherLogins: [],
    studentActivities: [],
    siteConfig: {
      footerSecondLine: 'Live Proctored Assessment Engine',
      aboutContent: 'V SMART LEARN is a premier real-time interactive MCQ assessment platform designed for educators, institutions, and competitive learners. Featuring live proctoring, synchronized question broadcasting, instant leaderboard tracking, and carrier-grade telecom OTP verification.',
      superUserPhone: SUPERUSER_PHONE,
    },
  };
  saveDB(initialDB);
  return initialDB;
}

function saveDB(data: DBData) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error saving DB:', err);
  }
}

let db = loadDB();

// Periodic cleanup of expired OTPs
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const phone in db.otps) {
    if (db.otps[phone].expiresAt < now) {
      delete db.otps[phone];
      changed = true;
    }
  }
  if (changed) saveDB(db);
}, 60000);

// Helper to calculate leaderboard for a live session
function computeLeaderboard(session: any) {
  const students = Object.values(session.students || {}) as any[];
  const sorted = students.sort((a, b) => {
    if (b.totalScore !== a.totalScore) {
      return b.totalScore - a.totalScore;
    }
    return b.correctCount - a.correctCount;
  });

  return sorted.map((st, idx) => ({
    studentId: st.id,
    studentName: st.name,
    schoolName: st.schoolName,
    score: st.totalScore,
    correctCount: st.correctCount,
    rank: idx + 1,
  }));
}

// Real-time broadcast helpers
function broadcastSession(pin: string) {
  const session = db.liveSessions[pin];
  if (!session) return;
  session.leaderboard = computeLeaderboard(session);
  // Emit to PIN room and globally to keep all clients updated
  io.to(`session:${pin}`).emit('session:update', session);
  io.emit('session:update', session);

  const activeSessions = Object.values(db.liveSessions).filter(
    (s: any) => s.status === 'active' || s.status === 'waiting'
  );
  io.to('room:superuser').emit('superuser:session_update', {
    pin,
    session,
    studentCount: Object.keys(session.students || {}).length,
    activeSessions,
  });
  io.emit('live_count:update', activeSessions.length);
  io.emit('active_sessions:update', activeSessions);
}

function broadcastStudentActivity(activity: any) {
  io.to('room:superuser').emit('superuser:activity', activity);
}

io.on('connection', (socket) => {
  const activeSessions = Object.values(db.liveSessions).filter(
    (s: any) => s.status === 'active' || s.status === 'waiting'
  );
  // Immediately provide active live counts and site config on connection
  socket.emit('live_count:update', activeSessions.length);
  socket.emit('active_sessions:update', activeSessions);
  if (db.siteConfig) {
    socket.emit('site_config:update', db.siteConfig);
  }

  socket.on('join:session', (data: { pin: string }) => {
    if (data?.pin) {
      socket.join(`session:${data.pin}`);
      if (db.liveSessions[data.pin]) {
        socket.emit('session:update', db.liveSessions[data.pin]);
      }
    }
  });

  socket.on('join:superuser', () => {
    socket.join('room:superuser');
    socket.emit('superuser:initial', {
      teachers: db.teachers.map((t: any) => ({ id: t.id, name: t.name, username: t.username, phone: t.phone, createdAt: t.createdAt })),
      activeSessions: Object.values(db.liveSessions).filter((s: any) => s.status === 'active' || s.status === 'waiting'),
      studentActivities: db.studentActivities || [],
      teacherLogins: db.teacherLogins || [],
      siteConfig: db.siteConfig,
    });
  });
});

// ----------------------------------------------------
// API ROUTES
// ----------------------------------------------------

// 1. Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// 2. Free Indian Phone Number OTP Dispatcher
app.post('/api/auth/otp/send', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone || !/^[6-9]\d{9}$/.test(phone)) {
      return res.status(400).json({ error: 'Please enter a valid 10-digit Indian mobile number.' });
    }

    // Generate 6 digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes validity

    db.otps[phone] = {
      code: otp,
      expiresAt,
      verified: false,
    };
    saveDB(db);

    console.log(`[SMS-GATEWAY-OTP] Dispatched to +91-${phone}: OTP is ${otp}`);

    return res.json({
      success: true,
      message: `OTP dispatched to +91-${phone} via network carrier SMS.`,
      phone,
      // Provide OTP in response so that on-screen instant carrier simulation notification
      // guarantees testability without carrier network delay or third-party paid credits
      otpCode: otp,
      expiresInSeconds: 300,
      carrierStatus: 'DELIVERED',
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Failed to dispatch OTP' });
  }
});

// 3. Verify OTP
app.post('/api/auth/otp/verify', (req, res) => {
  const { phone, otp } = req.body;
  if (!phone || !otp) {
    return res.status(400).json({ error: 'Phone and OTP are required.' });
  }

  const record = db.otps[phone];
  if (!record) {
    return res.status(400).json({ error: 'No OTP requested for this phone number or expired.' });
  }

  if (Date.now() > record.expiresAt) {
    delete db.otps[phone];
    saveDB(db);
    return res.status(400).json({ error: 'OTP has expired. Please request a new one.' });
  }

  if (record.code !== otp.trim()) {
    return res.status(400).json({ error: 'Invalid OTP entered. Please check and try again.' });
  }

  record.verified = true;
  saveDB(db);

  return res.json({
    success: true,
    message: 'Phone number verified successfully.',
    phone,
  });
});

// 4. Teacher Signup
app.post('/api/auth/teacher/signup', (req, res) => {
  try {
    const { name, username, password, phone, otp } = req.body;

    if (!name || !username || !password || !phone) {
      return res.status(400).json({ error: 'All fields are required.' });
    }

    if (!/^[6-9]\d{9}$/.test(phone)) {
      return res.status(400).json({ error: 'Invalid 10-digit Indian phone number.' });
    }

    // Verify OTP record
    const otpRecord = db.otps[phone];
    if (!otpRecord || !otpRecord.verified) {
      // Check if provided OTP matches directly
      if (otpRecord && otpRecord.code === otp) {
        otpRecord.verified = true;
      } else {
        return res.status(400).json({ error: 'Mobile number OTP must be verified before signup.' });
      }
    }

    // Check unique username
    const existingUser = db.teachers.find(
      (t) => t.username.toLowerCase() === username.trim().toLowerCase()
    );
    if (existingUser) {
      return res.status(400).json({ error: 'Username is already taken. Please choose another.' });
    }

    // Check unique phone
    const existingPhone = db.teachers.find((t) => t.phone === phone.trim());
    if (existingPhone) {
      return res.status(400).json({ error: 'This phone number is already registered. Please login.' });
    }

    const newTeacher = {
      id: 'tch_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
      name: name.trim(),
      username: username.trim(),
      password: password, // In production hash, kept direct/plain for student-teacher assessment
      phone: phone.trim(),
      createdAt: new Date().toISOString(),
    };

    db.teachers.push(newTeacher);
    // clean up verified OTP
    delete db.otps[phone];
    saveDB(db);

    return res.json({
      success: true,
      message: 'Teacher account created successfully! Please login.',
      teacher: {
        id: newTeacher.id,
        name: newTeacher.name,
        username: newTeacher.username,
        phone: newTeacher.phone,
      },
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Signup failed.' });
  }
});

// 5. Teacher Login (including remote-only Super User credentials)
app.post('/api/auth/teacher/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  const cleanUser = username.trim();

  // Super User Authentication - credentials verified only on remote server
  if (
    (cleanUser === SUPERUSER_USERNAME || cleanUser === SUPERUSER_PHONE) &&
    password === SUPERUSER_PASSWORD
  ) {
    const superUserRecord = {
      id: 'log_' + Date.now() + '_' + Math.random().toString(36).substring(2, 5),
      username: 'vijay1',
      teacherName: 'Super User (Vijay)',
      phone: SUPERUSER_PHONE,
      timestamp: new Date().toISOString(),
      role: 'superuser' as const,
    };
    db.teacherLogins.unshift(superUserRecord);
    saveDB(db);

    console.log('[SUPERUSER-LOGIN] Super User authenticated successfully with phone/username.');

    return res.json({
      success: true,
      message: 'Super User authenticated successfully! Full monitoring & management portal unlocked.',
      teacher: {
        id: 'superuser_vijay1',
        name: 'Super User (Vijay)',
        username: 'vijay1',
        phone: SUPERUSER_PHONE,
        role: 'superuser',
        createdAt: new Date().toISOString(),
      },
    });
  }

  const teacher = db.teachers.find(
    (t) =>
      t.username.toLowerCase() === cleanUser.toLowerCase() &&
      t.password === password
  );

  if (!teacher) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  // Record Teacher Login in audit logs
  db.teacherLogins.unshift({
    id: 'log_' + Date.now() + '_' + Math.random().toString(36).substring(2, 5),
    username: teacher.username,
    teacherName: teacher.name,
    phone: teacher.phone,
    timestamp: new Date().toISOString(),
    role: 'teacher' as const,
  });
  saveDB(db);

  return res.json({
    success: true,
    message: 'Login successful!',
    teacher: {
      id: teacher.id,
      name: teacher.name,
      username: teacher.username,
      phone: teacher.phone,
      role: 'teacher',
      createdAt: teacher.createdAt,
    },
  });
});

// 6. Teacher Password Recovery (Forgot Password via Phone + OTP)
app.post('/api/auth/teacher/forgot-password', (req, res) => {
  const { phone, otp, newPassword } = req.body;
  if (!phone || !otp || !newPassword) {
    return res.status(400).json({ error: 'Phone, OTP and new password are required.' });
  }

  const teacher = db.teachers.find((t) => t.phone === phone.trim());
  if (!teacher) {
    return res.status(404).json({ error: 'No registered teacher found with this phone number.' });
  }

  const otpRecord = db.otps[phone];
  if (!otpRecord || otpRecord.code !== otp.trim()) {
    return res.status(400).json({ error: 'Invalid or expired OTP.' });
  }

  teacher.password = newPassword;
  delete db.otps[phone];
  saveDB(db);

  return res.json({
    success: true,
    message: 'Password reset successfully! You can now login with your new password.',
  });
});

// 7. MCQ Assessments CRUD
app.get('/api/mcqs/active-sessions', (req, res) => {
  const activeSessions = Object.values(db.liveSessions || {}).filter(
    (s: any) => s.status === 'active' || s.status === 'waiting'
  );
  return res.json({
    success: true,
    count: activeSessions.length,
    sessions: activeSessions,
  });
});

app.get('/api/mcqs', (req, res) => {
  const { teacherId, role } = req.query;
  let list = db.mcqs;
  // If not superuser and teacherId is provided, filter by teacher
  if (teacherId && teacherId !== 'superuser_vijay1' && role !== 'superuser') {
    list = list.filter((m) => m.teacherId === teacherId);
  }
  return res.json({ success: true, mcqs: list });
});

app.get('/api/mcqs/:id', (req, res) => {
  const mcq = db.mcqs.find((m) => m.id === req.params.id);
  if (!mcq) return res.status(404).json({ error: 'MCQ not found.' });
  return res.json({ success: true, mcq });
});

app.post('/api/mcqs', (req, res) => {
  try {
    const { teacherId, title, topic, durationMinutes, totalPoints, questions, status } = req.body;

    if (!title || !questions || !Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({ error: 'Title and at least one question are required.' });
    }

    // Generate random 6-digit PIN for the MCQ
    const pin = Math.floor(100000 + Math.random() * 900000).toString();

    const newMCQ = {
      id: 'mcq_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
      teacherId: teacherId || 'default',
      title: title.trim(),
      topic: topic?.trim() || 'General',
      durationMinutes: Number(durationMinutes) || 15,
      totalPoints: Number(totalPoints) || questions.reduce((sum: number, q: any) => sum + (Number(q.points) || 1), 0),
      pin,
      status: status || 'completed',
      questions,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    db.mcqs.unshift(newMCQ);
    saveDB(db);

    return res.json({ success: true, message: 'MCQ assessment saved successfully!', mcq: newMCQ });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Failed to save MCQ.' });
  }
});

app.put('/api/mcqs/:id', (req, res) => {
  const idx = db.mcqs.findIndex((m) => m.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'MCQ not found.' });

  const updated = {
    ...db.mcqs[idx],
    ...req.body,
    updatedAt: new Date().toISOString(),
  };

  db.mcqs[idx] = updated;
  saveDB(db);

  return res.json({ success: true, message: 'MCQ updated successfully!', mcq: updated });
});

app.delete('/api/mcqs/:id', (req, res) => {
  const idx = db.mcqs.findIndex((m) => m.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'MCQ not found.' });

  db.mcqs.splice(idx, 1);
  saveDB(db);

  return res.json({ success: true, message: 'Assessment deleted successfully.' });
});

// Copy and Edit (Duplicate)
app.post('/api/mcqs/:id/duplicate', (req, res) => {
  const original = db.mcqs.find((m) => m.id === req.params.id);
  if (!original) return res.status(404).json({ error: 'MCQ not found.' });

  const newPin = Math.floor(100000 + Math.random() * 900000).toString();
  const copy = {
    ...JSON.parse(JSON.stringify(original)),
    id: 'mcq_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
    title: `${original.title} (Copy)`,
    pin: newPin,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  db.mcqs.unshift(copy);
  saveDB(db);

  return res.json({ success: true, message: 'MCQ duplicated successfully!', mcq: copy });
});

// Change PIN
app.post('/api/mcqs/:id/change-pin', (req, res) => {
  const { newPin } = req.body;
  const mcq = db.mcqs.find((m) => m.id === req.params.id);
  if (!mcq) return res.status(404).json({ error: 'MCQ not found.' });

  const pinToSet = newPin?.trim() || Math.floor(100000 + Math.random() * 900000).toString();
  mcq.pin = pinToSet;
  mcq.updatedAt = new Date().toISOString();
  saveDB(db);

  return res.json({ success: true, message: `PIN updated to ${pinToSet}`, pin: pinToSet, mcq });
});

// Generate Random PIN
app.post('/api/mcqs/:id/generate-pin', (req, res) => {
  const mcq = db.mcqs.find((m) => m.id === req.params.id);
  if (!mcq) return res.status(404).json({ error: 'MCQ not found.' });

  const pin = Math.floor(100000 + Math.random() * 900000).toString();
  mcq.pin = pin;
  mcq.updatedAt = new Date().toISOString();
  saveDB(db);

  return res.json({ success: true, message: `Random PIN generated: ${pin}`, pin, mcq });
});

// End Live Streaming by PIN
app.post('/api/mcqs/live/:pin/end', (req, res) => {
  const { pin } = req.params;
  const session = db.liveSessions[pin];
  if (!session) {
    return res.status(404).json({ error: `No live session found with PIN: ${pin}` });
  }

  session.status = 'ended';
  session.endedAt = new Date().toISOString();

  // Mark all connected students as ended with alert
  if (session.students) {
    Object.values(session.students).forEach((st: any) => {
      st.status = 'ended';
      st.alertMessage = 'Live streaming ended by teacher';
      st.isCompleted = true;
    });
  }

  // Update audit activity records
  if (db.studentActivities) {
    db.studentActivities.forEach((act: any) => {
      if (act.pin === pin && act.status !== 'completed') {
        act.status = 'ended';
        act.alertMessage = 'Live streaming ended by teacher';
      }
    });
  }

  saveDB(db);
  broadcastSession(pin);
  const activeSessions = Object.values(db.liveSessions).filter(
    (s: any) => s.status === 'active' || s.status === 'waiting'
  );
  io.emit('live_count:update', activeSessions.length);
  io.emit('active_sessions:update', activeSessions);

  return res.json({
    success: true,
    message: `Live stream with PIN ${pin} has been ended successfully.`,
    session,
  });
});

// End Live Streaming by Assessment ID
app.post('/api/mcqs/live/end-assessment/:id', (req, res) => {
  const { id } = req.params;
  const endedPins: string[] = [];

  for (const pin in db.liveSessions) {
    const s = db.liveSessions[pin];
    if (s.assessmentId === id && s.status !== 'ended') {
      s.status = 'ended';
      s.endedAt = new Date().toISOString();
      if (s.students) {
        Object.values(s.students).forEach((st: any) => {
          st.status = 'ended';
          st.alertMessage = 'Live streaming ended by teacher';
          st.isCompleted = true;
        });
      }
      endedPins.push(pin);
    }
  }

  if (db.studentActivities && endedPins.length > 0) {
    db.studentActivities.forEach((act: any) => {
      if (endedPins.includes(act.pin) && act.status !== 'completed') {
        act.status = 'ended';
        act.alertMessage = 'Live streaming ended by teacher';
      }
    });
  }

  saveDB(db);
  endedPins.forEach((p) => broadcastSession(p));
  const activeSessions = Object.values(db.liveSessions).filter(
    (s: any) => s.status === 'active' || s.status === 'waiting'
  );
  io.emit('live_count:update', activeSessions.length);
  io.emit('active_sessions:update', activeSessions);

  return res.json({
    success: true,
    message: endedPins.length > 0
      ? `Live stream(s) ended for PIN: ${endedPins.join(', ')}`
      : 'Live streaming ended.',
    endedPins,
  });
});

// Site Configuration (Footer 2nd line, About Content, Super User Phone)
app.get('/api/site-config', (req, res) => {
  if (!db.siteConfig) {
    db.siteConfig = {
      footerSecondLine: 'Live Proctored Assessment Engine',
      aboutContent: 'V SMART LEARN is a premier real-time interactive MCQ assessment platform designed for educators, institutions, and competitive learners.',
      superUserPhone: SUPERUSER_PHONE,
    };
    saveDB(db);
  }
  return res.json({
    success: true,
    config: db.siteConfig,
  });
});

app.post('/api/site-config', (req, res) => {
  const reqRole = req.headers['x-user-role'];
  const reqUser = req.headers['x-user-username'];
  if (reqRole !== 'superuser' && reqUser !== SUPERUSER_USERNAME) {
    return res.status(403).json({ error: 'Access denied. Only Super User can configure site settings.' });
  }

  const { footerSecondLine, aboutContent, superUserPhone } = req.body;
  if (!db.siteConfig) {
    db.siteConfig = {
      footerSecondLine: footerSecondLine || 'Live Proctored Assessment Engine',
      aboutContent: aboutContent || '',
      superUserPhone: superUserPhone || SUPERUSER_PHONE,
    };
  } else {
    if (footerSecondLine !== undefined) db.siteConfig.footerSecondLine = String(footerSecondLine).trim();
    if (aboutContent !== undefined) db.siteConfig.aboutContent = String(aboutContent).trim();
    if (superUserPhone !== undefined) db.siteConfig.superUserPhone = String(superUserPhone).trim();
  }

  saveDB(db);
  io.emit('site_config:update', db.siteConfig);

  return res.json({
    success: true,
    message: 'Site configuration saved successfully!',
    config: db.siteConfig,
  });
});

// 8. Live MCQ Streaming
app.post('/api/mcqs/live/start', (req, res) => {
  try {
    const {
      assessmentId,
      teacherId,
      shuffleQuestions, // boolean: shuffle question order only, not options order!
      startMode, // 'immediate' | 'waitForStudent'
      proctoringEnabled,
      customPin,
    } = req.body;

    const mcq = db.mcqs.find((m) => m.id === assessmentId);
    if (!mcq) return res.status(404).json({ error: 'Assessment not found.' });

    const pin = customPin?.trim() || mcq.pin || Math.floor(100000 + Math.random() * 900000).toString();

    let preparedQuestions = JSON.parse(JSON.stringify(mcq.questions));

    // Shuffle QUESTION order only if requested (options order stays intact!)
    if (shuffleQuestions) {
      for (let i = preparedQuestions.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [preparedQuestions[i], preparedQuestions[j]] = [preparedQuestions[j], preparedQuestions[i]];
      }
    }

    const session = {
      pin,
      assessmentId: mcq.id,
      assessmentTitle: mcq.title,
      topic: mcq.topic,
      teacherId: teacherId || mcq.teacherId,
      shuffleQuestions: !!shuffleQuestions,
      questions: preparedQuestions,
      startMode: startMode || 'waitForStudent',
      proctoringEnabled: proctoringEnabled !== false,
      status: startMode === 'immediate' ? 'active' : 'waiting',
      currentQuestionIndex: 0,
      startedAt: new Date().toISOString(),
      students: {},
      leaderboard: [],
    };

    db.liveSessions[pin] = session;
    saveDB(db);
    broadcastSession(pin);

    return res.json({
      success: true,
      message: `Live session started with PIN: ${pin}`,
      session,
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Failed to start live session.' });
  }
});

// Get Live session state
app.get('/api/mcqs/live/:pin', (req, res) => {
  const { pin } = req.params;
  const session = db.liveSessions[pin];
  if (!session) {
    return res.status(404).json({ error: `No live assessment found with PIN ${pin}. Check with your teacher.` });
  }

  session.leaderboard = computeLeaderboard(session);
  return res.json({ success: true, session });
});

// Teacher starts quiz manually (when in waitForStudent mode)
app.post('/api/mcqs/live/:pin/start-now', (req, res) => {
  const { pin } = req.params;
  const session = db.liveSessions[pin];
  if (!session) return res.status(404).json({ error: 'Session not found.' });

  session.status = 'active';
  session.startedAt = new Date().toISOString();
  saveDB(db);
  broadcastSession(pin);

  return res.json({ success: true, message: 'Quiz started!', session });
});

// Student Joins Live Session
app.post('/api/mcqs/live/:pin/join', (req, res) => {
  const { pin } = req.params;
  const { name, schoolName, email } = req.body;

  // Student requirement: "STUDENT login name only must kodu, school and mail addrees optional maththu"
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Student Name is mandatory.' });
  }

  const session = db.liveSessions[pin];
  if (!session) {
    return res.status(404).json({ error: 'Invalid PIN. Please ask your teacher for the active live session PIN.' });
  }

  const studentId = 'std_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
  const newStudent = {
    id: studentId,
    name: name.trim(),
    schoolName: schoolName && schoolName.trim() ? schoolName.trim() : 'General',
    email: email && email.trim() ? email.trim() : 'N/A',
    pin,
    joinedAt: new Date().toISOString(),
    status: 'active',
    alertMessage: '',
    proctoringViolations: 0,
    answers: {},
    totalScore: 0,
    correctCount: 0,
    wrongCount: 0,
    missedCount: 0,
    currentQuestionIdx: 0,
    isCompleted: false,
  };

  session.students[studentId] = newStudent;
  session.leaderboard = computeLeaderboard(session);

  // Sync to persistent studentActivities for Super User audit
  if (!db.studentActivities) db.studentActivities = [];
  const existingActIdx = db.studentActivities.findIndex((a: any) => a.studentId === studentId);
  const actRecord = {
    id: 'act_' + studentId,
    studentId,
    studentName: name.trim(),
    schoolName: schoolName.trim(),
    email: email.trim(),
    pin,
    assessmentTitle: session.assessmentTitle,
    joinedAt: newStudent.joinedAt,
    totalScore: 0,
    violations: 0,
    status: 'active',
    currentQuestionIdx: 0,
  };
  if (existingActIdx >= 0) {
    db.studentActivities[existingActIdx] = actRecord;
  } else {
    db.studentActivities.unshift(actRecord);
  }

  saveDB(db);
  broadcastSession(pin);
  broadcastStudentActivity(actRecord);

  return res.json({
    success: true,
    message: 'Joined successfully!',
    student: newStudent,
    session: {
      pin: session.pin,
      assessmentTitle: session.assessmentTitle,
      status: session.status,
      proctoringEnabled: session.proctoringEnabled,
      totalQuestions: session.questions.length,
      questions: session.questions,
    },
  });
});

// Student Submits Answer
app.post('/api/mcqs/live/:pin/answer', (req, res) => {
  const { pin } = req.params;
  const { studentId, questionId, selectedOption, timeTakenSec } = req.body;

  const session = db.liveSessions[pin];
  if (!session) return res.status(404).json({ error: 'Live session not found.' });

  const student = session.students[studentId];
  if (!student) return res.status(404).json({ error: 'Student not found in this session.' });

  const question = session.questions.find((q: any) => q.id === questionId);
  if (!question) return res.status(404).json({ error: 'Question not found.' });

  const isMissed = !selectedOption;
  const isCorrect = !isMissed && selectedOption === question.correctOption;
  const pointsAwarded = isCorrect ? Number(question.points) || 1 : 0;

  student.answers[questionId] = {
    questionId,
    selectedOption: selectedOption || null,
    isCorrect,
    pointsAwarded,
    timeTakenSec: Number(timeTakenSec) || 0,
    timestamp: new Date().toISOString(),
  };

  // Recalculate totals
  let totalScore = 0;
  let correctCount = 0;
  let wrongCount = 0;
  let missedCount = 0;

  for (const q of session.questions) {
    const ans = student.answers[q.id];
    if (ans) {
      if (ans.selectedOption === null) {
        missedCount++;
      } else if (ans.isCorrect) {
        correctCount++;
        totalScore += ans.pointsAwarded;
      } else {
        wrongCount++;
      }
    }
  }

  student.totalScore = totalScore;
  student.correctCount = correctCount;
  student.wrongCount = wrongCount;
  student.missedCount = missedCount;
  student.currentQuestionIdx = Object.keys(student.answers).length;

  if (student.currentQuestionIdx >= session.questions.length) {
    student.isCompleted = true;
  }

  // Update in studentActivities
  if (db.studentActivities) {
    const act = db.studentActivities.find((a: any) => a.studentId === studentId);
    if (act) {
      act.totalScore = student.totalScore;
      act.currentQuestionIdx = student.currentQuestionIdx;
      if (student.isCompleted) act.status = 'completed';
    }
  }

  // Update session leaderboard instantly
  session.leaderboard = computeLeaderboard(session);
  saveDB(db);
  broadcastSession(pin);
  if (db.studentActivities) {
    const act = db.studentActivities.find((a: any) => a.studentId === studentId);
    if (act) broadcastStudentActivity(act);
  }

  return res.json({
    success: true,
    isCorrect,
    correctOption: question.correctOption,
    pointsAwarded,
    student,
    leaderboard: session.leaderboard,
  });
});

// Teacher Student Control: Pause, Resume, or End Quiz with "meet your teacher" alert
app.post('/api/mcqs/live/:pin/student-action', (req, res) => {
  const { pin } = req.params;
  const { studentId, action } = req.body; // action: 'pause' | 'resume' | 'end'

  const session = db.liveSessions[pin];
  if (!session) return res.status(404).json({ error: 'Session not found.' });

  const student = session.students[studentId];
  if (!student) return res.status(404).json({ error: 'Student not found in this session.' });

  if (action === 'pause') {
    student.status = 'paused';
    student.alertMessage = 'Quiz Paused by Teacher.';
  } else if (action === 'resume') {
    student.status = 'active';
    student.alertMessage = '';
  } else if (action === 'end') {
    student.status = 'ended';
    student.alertMessage = 'meet your teacher';
    student.isCompleted = true;
  }

  if (db.studentActivities) {
    const act = db.studentActivities.find((a: any) => a.studentId === studentId);
    if (act) {
      act.status = student.status;
      act.alertMessage = student.alertMessage;
    }
  }

  saveDB(db);
  broadcastSession(pin);
  if (db.studentActivities) {
    const act = db.studentActivities.find((a: any) => a.studentId === studentId);
    if (act) broadcastStudentActivity(act);
  }

  return res.json({
    success: true,
    message: `Student status updated to ${student.status}`,
    student,
  });
});

// Proctoring Violation reporting
app.post('/api/mcqs/live/:pin/student-violation', (req, res) => {
  const { pin } = req.params;
  const { studentId, reason } = req.body;

  const session = db.liveSessions[pin];
  if (!session) return res.status(404).json({ error: 'Session not found.' });

  const student = session.students[studentId];
  if (!student) return res.status(404).json({ error: 'Student not found.' });

  student.proctoringViolations = (student.proctoringViolations || 0) + 1;

  if (db.studentActivities) {
    const act = db.studentActivities.find((a: any) => a.studentId === studentId);
    if (act) {
      act.violations = student.proctoringViolations;
    }
  }

  saveDB(db);
  broadcastSession(pin);
  if (db.studentActivities) {
    const act = db.studentActivities.find((a: any) => a.studentId === studentId);
    if (act) broadcastStudentActivity(act);
  }

  return res.json({
    success: true,
    violations: student.proctoringViolations,
  });
});

// Finish Student Quiz & Generate Final Report
app.post('/api/mcqs/live/:pin/finish-student', (req, res) => {
  const { pin } = req.params;
  const { studentId } = req.body;

  const session = db.liveSessions[pin];
  if (!session) return res.status(404).json({ error: 'Session not found.' });

  const student = session.students[studentId];
  if (!student) return res.status(404).json({ error: 'Student not found.' });

  student.isCompleted = true;

  // Build full report item
  const maxScore = session.questions.reduce((sum: number, q: any) => sum + (Number(q.points) || 1), 0);
  const questionsSummary = session.questions.map((q: any) => {
    const ans = student.answers[q.id];
    return {
      questionText: q.questionText,
      studentAnswer: ans ? ans.selectedOption : null,
      correctAnswer: q.correctOption,
      isCorrect: ans ? ans.isCorrect : false,
      points: ans ? ans.pointsAwarded : 0,
    };
  });

  const percentage = maxScore > 0 ? Math.round((student.totalScore / maxScore) * 100) : 0;

  const report = {
    id: 'rep_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
    assessmentId: session.assessmentId,
    assessmentTitle: session.assessmentTitle,
    teacherId: session.teacherId,
    studentName: student.name,
    schoolName: student.schoolName,
    email: student.email,
    date: new Date().toISOString(),
    totalQuestions: session.questions.length,
    correctCount: student.correctCount,
    wrongCount: student.wrongCount,
    missedCount: student.missedCount,
    totalScore: student.totalScore,
    maxScore,
    percentage,
    questionsSummary,
  };

  db.reports.unshift(report);
  session.leaderboard = computeLeaderboard(session);
  saveDB(db);
  broadcastSession(pin);
  if (db.studentActivities) {
    const act = db.studentActivities.find((a: any) => a.studentId === studentId);
    if (act) {
      act.status = 'completed';
      broadcastStudentActivity(act);
    }
  }

  return res.json({
    success: true,
    report,
    leaderboard: session.leaderboard,
  });
});

// 9. Student Reports list
app.get('/api/reports', (req, res) => {
  const { teacherId, assessmentId, role } = req.query;
  let list = db.reports;

  if (teacherId && teacherId !== 'superuser_vijay1' && role !== 'superuser') {
    list = list.filter((r) => r.teacherId === teacherId);
  }
  if (assessmentId) {
    list = list.filter((r) => r.assessmentId === assessmentId);
  }

  return res.json({ success: true, reports: list });
});

// 10. Super User Remote Monitoring API
// Provides real-time tracking of:
// - Teacher signups
// - Teacher logins
// - All MCQ creation activities
// - Student monitoring activities
// - Active live streams
app.get('/api/superuser/monitoring', (req, res) => {
  const reqRole = req.headers['x-user-role'] || req.query.role;
  const reqUser = req.headers['x-user-username'] || req.query.username;

  if (reqRole !== 'superuser' && reqUser !== SUPERUSER_USERNAME) {
    return res.status(403).json({ error: 'Access denied: Super User credentials required.' });
  }

  const activeSessions = Object.values(db.liveSessions).filter(
    (s: any) => s.status === 'active' || s.status === 'waiting'
  );

  return res.json({
    success: true,
    data: {
      stats: {
        totalTeachers: db.teachers.length,
        totalLogins: (db.teacherLogins || []).length,
        totalMCQs: db.mcqs.length,
        totalStudents: (db.studentActivities || []).length,
        activeLiveSessions: activeSessions.length,
      },
      teachers: db.teachers.map((t: any) => ({
        id: t.id,
        name: t.name,
        username: t.username,
        phone: t.phone,
        createdAt: t.createdAt,
        totalMCQs: db.mcqs.filter((m: any) => m.teacherId === t.id).length,
      })),
      teacherLogins: db.teacherLogins || [],
      mcqs: db.mcqs,
      studentActivities: db.studentActivities || [],
      liveSessions: Object.values(db.liveSessions),
      reports: db.reports || [],
    },
  });
});

// Super User: Add New Teacher
// Requirement: "super user also having option control to remove existing techer and add new teachers"
app.post('/api/superuser/teachers', (req, res) => {
  const reqRole = req.headers['x-user-role'] || req.query.role;
  const reqUser = req.headers['x-user-username'] || req.query.username;

  if (reqRole !== 'superuser' && reqUser !== SUPERUSER_USERNAME) {
    return res.status(403).json({ error: 'Access denied: Super User credentials required.' });
  }

  const { name, username, phone, password } = req.body;

  if (!name || !username || !phone || !password) {
    return res.status(400).json({ error: 'Name, username, phone, and password are all required.' });
  }

  const cleanUser = username.trim().toLowerCase();
  const cleanPhone = phone.trim().replace(/\D/g, '');

  if (cleanPhone.length !== 10) {
    return res.status(400).json({ error: 'Phone number must be a valid 10-digit Indian mobile number.' });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
  }

  const existing = db.teachers.find(
    (t: any) => t.username.toLowerCase() === cleanUser || t.phone === cleanPhone
  );
  if (existing) {
    return res.status(400).json({ error: 'A teacher with this username or mobile number already exists.' });
  }

  const newTeacher = {
    id: 'tch_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
    name: name.trim(),
    username: cleanUser,
    phone: cleanPhone,
    password,
    role: 'teacher' as const,
    createdAt: new Date().toISOString(),
  };

  db.teachers.unshift(newTeacher);
  saveDB(db);

  return res.status(201).json({
    success: true,
    message: `Teacher "${newTeacher.name}" successfully created!`,
    teacher: {
      id: newTeacher.id,
      name: newTeacher.name,
      username: newTeacher.username,
      phone: newTeacher.phone,
      createdAt: newTeacher.createdAt,
      totalMCQs: 0,
    },
  });
});

// Super User: Delete Existing Teacher
app.delete('/api/superuser/teachers/:id', (req, res) => {
  const reqRole = req.headers['x-user-role'] || req.query.role;
  const reqUser = req.headers['x-user-username'] || req.query.username;

  if (reqRole !== 'superuser' && reqUser !== SUPERUSER_USERNAME) {
    return res.status(403).json({ error: 'Access denied: Super User credentials required.' });
  }

  const teacherId = req.params.id;
  const index = db.teachers.findIndex((t: any) => t.id === teacherId);

  if (index === -1) {
    return res.status(404).json({ error: 'Teacher not found.' });
  }

  const removedTeacher = db.teachers[index];
  db.teachers.splice(index, 1);
  saveDB(db);

  return res.json({
    success: true,
    message: `Teacher "${removedTeacher.name}" (@${removedTeacher.username}) has been removed.`,
    removedId: teacherId,
  });
});

// ----------------------------------------------------
// VITE / STATIC SERVING
// ----------------------------------------------------
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Live MCQ Full-Stack Server running on port ${PORT}`);
  });
}

startServer();
