const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const multer = require('multer');
const QRCode = require('qrcode');
const os = require('os');

const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
    path: '/socket.io',
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    transports: ['websocket', 'polling']
});

io.engine.on("connection_error", (err) => {
  console.log("Connection Error:", err.req ? err.req.url : 'no req');
  console.log("Error Code:", err.code);
  console.log("Error Message:", err.message);
  console.log("Error Context:", err.context);
});

const upload = multer({ dest: 'uploads/' });

const PORT = process.env.PORT || 3001;

// Directories
const QUIZZES_DIR = path.join(__dirname, 'quizzes');
const STATS_DIR = path.join(__dirname, 'stats');
if (!fs.existsSync(QUIZZES_DIR)) fs.mkdirSync(QUIZZES_DIR);
if (!fs.existsSync(STATS_DIR)) fs.mkdirSync(STATS_DIR);

// Migration: Move existing .json files into their own folders
function migrateQuizzes() {
    const files = fs.readdirSync(QUIZZES_DIR);
    files.forEach(f => {
        const fullPath = path.join(QUIZZES_DIR, f);
        if (fs.statSync(fullPath).isFile() && f.endsWith('.json')) {
            const quizId = f.replace('.json', '');
            const folderPath = path.join(QUIZZES_DIR, quizId);
            if (!fs.existsSync(folderPath)) fs.mkdirSync(folderPath);
            fs.renameSync(fullPath, path.join(folderPath, 'quiz.json'));
            console.log(`Migrated quiz: ${f} -> ${quizId}/quiz.json`);
        }
    });
}
migrateQuizzes();

// Game State
let gameState = {
    status: 'LOBBY', 
    questions: [],
    currentQuestionIndex: -1,
    players: {}, // Now indexed by permanent playerId
    socketToPlayer: {}, // Map socket.id to playerId
    answersReceived: 0,
    startTime: null,
    quizTitle: 'Квиз',
    pin: null
};

app.use(require('cors')({
    origin: "https://notvlesskarm.ru"
}));
app.use(express.static('public'));
app.use('/quizzes', express.static('quizzes'));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Get local IP
function getLocalIp() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'localhost';
}

const serverUrl = 'https://notvlesskarm.ru/quiz';

// API Routes
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/api/server-info', (req, res) => {
    const urlWithPin = `${serverUrl}/?pin=${gameState.pin}`;
    QRCode.toDataURL(urlWithPin, (err, url) => {
        res.json({ url: serverUrl, urlWithPin: urlWithPin, qr: url, pin: gameState.pin, title: gameState.quizTitle });
    });
});

app.get('/api/quizzes', (req, res) => {
    const items = fs.readdirSync(QUIZZES_DIR);
    const quizzes = items.map(id => {
        const dirPath = path.join(QUIZZES_DIR, id);
        if (!fs.statSync(dirPath).isDirectory()) return null;
        
        const quizPath = path.join(dirPath, 'quiz.json');
        if (!fs.existsSync(quizPath)) return null;

        const content = JSON.parse(fs.readFileSync(quizPath, 'utf8'));
        const stats = fs.statSync(quizPath);
        return { 
            id: id,
            title: content.title || id,
            date: stats.mtime.toLocaleString()
        };
    }).filter(q => q !== null);
    res.json(quizzes);
});

app.post('/api/save-quiz', (req, res) => {
    const { title, questions, id } = req.body;
    const quizId = id || Date.now().toString();
    const folderPath = path.join(QUIZZES_DIR, quizId);
    
    if (!fs.existsSync(folderPath)) fs.mkdirSync(folderPath);
    
    fs.writeFileSync(path.join(folderPath, 'quiz.json'), JSON.stringify({ title, questions }, null, 2));
    res.json({ success: true, id: quizId });
});

app.post('/api/import-quiz', (req, res) => {
    const { title, questions } = req.body;
    if (!title || !questions || !Array.isArray(questions)) {
        return res.status(400).json({ error: 'Invalid quiz format' });
    }
    const quizId = Date.now().toString();
    const folderPath = path.join(QUIZZES_DIR, quizId);
    
    if (!fs.existsSync(folderPath)) fs.mkdirSync(folderPath);
    
    fs.writeFileSync(path.join(folderPath, 'quiz.json'), JSON.stringify({ title, questions }, null, 2));
    res.json({ success: true, id: quizId });
});

app.post('/api/select-quiz', (req, res) => {
    const { id } = req.body;
    try {
        const quizPath = path.join(QUIZZES_DIR, id, 'quiz.json');
        const data = JSON.parse(fs.readFileSync(quizPath, 'utf8'));
        gameState.questions = data.questions || [];
        gameState.quizId = id; // Store active quiz ID for image paths
        gameState.quizTitle = data.title || id;
        gameState.status = 'LOBBY';
        gameState.currentQuestionIndex = -1;
        gameState.players = {};
        gameState.pin = Math.floor(100000 + Math.random() * 900000).toString();
        res.json({ success: true, count: gameState.questions.length, pin: gameState.pin });
    } catch (e) {
        res.status(400).json({ error: 'Failed to load quiz' });
    }
});

app.delete('/api/delete-quiz/:id', (req, res) => {
    const quizId = req.params.id;
    const folderPath = path.join(QUIZZES_DIR, quizId);
    if (fs.existsSync(folderPath)) {
        fs.rmSync(folderPath, { recursive: true, force: true });
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Quiz not found' });
    }
});

// Image Upload API (supports file upload and base64)
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const quizId = req.params.quizId;
        const dir = path.join(QUIZZES_DIR, quizId);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});
const uploadImg = multer({ storage });

app.post('/api/upload-image/:quizId', uploadImg.single('image'), (req, res) => {
    if (req.file) {
        return res.json({ path: `/quiz/quizzes/${req.params.quizId}/${req.file.filename}` });
    }
    
    // Support base64 (clipboard)
    if (req.body.image && req.body.image.startsWith('data:image')) {
        const quizId = req.params.quizId;
        const dir = path.join(QUIZZES_DIR, quizId);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        
        const base64Data = req.body.image.replace(/^data:image\/\w+;base64,/, "");
        const ext = req.body.image.match(/\/(.*?);/)[1];
        const filename = `${Date.now()}.${ext}`;
        const filePath = path.join(dir, filename);
        
        fs.writeFileSync(filePath, base64Data, 'base64');
        return res.json({ path: `/quiz/quizzes/${quizId}/${filename}` });
    }
    
    res.status(400).json({ error: 'No image provided' });
});

app.get('/api/get-quiz/:id', (req, res) => {
    const quizId = req.params.id;
    const quizPath = path.join(QUIZZES_DIR, quizId, 'quiz.json');
    if (fs.existsSync(quizPath)) {
        const data = JSON.parse(fs.readFileSync(quizPath, 'utf8'));
        res.json(data);
    } else {
        res.status(404).json({ error: 'Quiz not found' });
    }
});

app.get('/api/stats', (req, res) => {
    const statsFile = path.join(STATS_DIR, 'history.json');
    if (!fs.existsSync(statsFile)) return res.json([]);
    const stats = JSON.parse(fs.readFileSync(statsFile, 'utf8'));
    res.json(stats);
});

function saveSessionStats(leaderboard) {
    const statsFile = path.join(STATS_DIR, 'history.json');
    let history = [];
    if (fs.existsSync(statsFile)) {
        history = JSON.parse(fs.readFileSync(statsFile, 'utf8'));
    }
    history.push({
        id: Date.now(),
        title: gameState.quizTitle,
        date: new Date().toLocaleString(),
        playersCount: Object.keys(gameState.players).length,
        winner: leaderboard[0] ? leaderboard[0].name : '-',
        questions: gameState.questions, // Store full questions
        results: gameState.players, // Store full players data with answers
        leaderboard: leaderboard // Store full leaderboard
    });
    fs.writeFileSync(statsFile, JSON.stringify(history, null, 2));
}

// Socket.io logic
io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id} (Transport: ${socket.conn.transport.name})`);

    socket.on('validate_pin', (data) => {
        console.log(`PIN attempt from ${socket.id}: ${data.pin} (Target: ${gameState.pin}, Status: ${gameState.status})`);
        // Allow PIN validation even if game started (for late join)
        if (gameState.pin && data.pin === gameState.pin) {
            console.log('PIN valid');
            socket.emit('pin_valid', { status: gameState.status });
        } else {
            console.log('PIN invalid');
            socket.emit('pin_invalid', { message: !gameState.pin ? 'Квиз еще не запущен' : 'Неверный PIN' });
        }
    });

    socket.on('join', (data) => {
        const { playerId, name, emoji } = data;
        if (!playerId) return;

        console.log(`Join attempt: ${name} (${playerId})`);
        
        // Handle reconnection
        if (gameState.players[playerId]) {
            const player = gameState.players[playerId];
            player.socketId = socket.id;
            player.connected = true;
            gameState.socketToPlayer[socket.id] = playerId;
            
            console.log(`Player reconnected: ${name}`);
            socket.emit('joined', { status: gameState.status, score: player.score });
            
            // Sync current state
            if (gameState.status === 'PLAYING') {
                const currentQ = gameState.questions[gameState.currentQuestionIndex];
                socket.emit('new_question', {
                    index: gameState.currentQuestionIndex,
                    total: gameState.questions.length,
                    question: currentQ.text,
                    image: currentQ.image,
                    options: currentQ.options,
                    optionImages: currentQ.optionImages,
                    time: Math.max(0, Math.floor((currentQ.time * 1000 - (Date.now() - gameState.startTime)) / 1000)),
                    type: currentQ.type || 'SINGLE',
                    rejoin: true
                });
            } else if (gameState.status === 'QUESTION_RESULTS') {
                sendResultsToSocket(socket);
            } else if (gameState.status === 'RESULTS') {
                socket.emit('final_results', { leaderboard: getLeaderboard() });
            }
        } else {
            // New player or Late join
            gameState.players[playerId] = {
                id: playerId,
                socketId: socket.id,
                name: name,
                emoji: emoji,
                score: 0,
                connected: true,
                answers: {}
            };
            gameState.socketToPlayer[socket.id] = playerId;
            
            console.log(`New player joined: ${name}`);
            socket.emit('joined', { status: gameState.status });

            // If late join during question
            if (gameState.status === 'PLAYING') {
                const currentQ = gameState.questions[gameState.currentQuestionIndex];
                socket.emit('new_question', {
                    index: gameState.currentQuestionIndex,
                    total: gameState.questions.length,
                    question: currentQ.text,
                    image: currentQ.image,
                    options: currentQ.options,
                    optionImages: currentQ.optionImages,
                    time: Math.max(0, Math.floor((currentQ.time * 1000 - (Date.now() - gameState.startTime)) / 1000)),
                    type: currentQ.type || 'SINGLE'
                });
            }
        }
        
        io.emit('player_list', Object.values(gameState.players));
    });

    socket.on('start_quiz', () => {
        if (gameState.questions.length === 0) return;
        nextQuestion();
    });

    socket.on('submit_answer', (data) => {
        const playerId = gameState.socketToPlayer[socket.id];
        const player = gameState.players[playerId];
        if (!player || gameState.status !== 'PLAYING') return;

        const currentQ = gameState.questions[gameState.currentQuestionIndex];
        let isCorrect = false;

        if (currentQ.type === 'SINGLE' || !currentQ.type) {
            isCorrect = (data.answerIndex == currentQ.correctAnswer);
        } else if (currentQ.type === 'MULTI') {
            const studentAnswers = (data.answerIndices || []).map(i => i.toString()).sort().join(',');
            const correctAnswers = (currentQ.correctAnswers || []).map(i => i.toString()).sort().join(',');
            isCorrect = studentAnswers === correctAnswers && studentAnswers !== '';
        } else if (currentQ.type === 'TEXT') {
            const studentText = (data.answerText || '').trim().toLowerCase();
            const correctText = (currentQ.correctText || '').trim().toLowerCase();
            isCorrect = studentText === correctText && correctText !== '';
        }

        const timeTaken = Date.now() - gameState.startTime;
        const remainingTime = Math.max(0, currentQ.time * 1000 - timeTaken);
        
        let points = 0;
        if (isCorrect) {
            points = 1000 + Math.floor((remainingTime / (currentQ.time * 1000)) * 1000);
            player.score += points;
        }

        player.answers[gameState.currentQuestionIndex] = { 
            correct: isCorrect, 
            points, 
            time: timeTaken,
            type: currentQ.type || 'SINGLE',
            answer: currentQ.type === 'TEXT' ? data.answerText : (currentQ.type === 'MULTI' ? data.answerIndices : data.answerIndex)
        };
        gameState.answersReceived++;
        socket.emit('answer_received');
        io.emit('player_answered', { playerId: playerId, count: gameState.answersReceived });

        const connectedPlayers = Object.values(gameState.players).filter(p => p.connected).length;
        if (gameState.answersReceived >= connectedPlayers) {
            finishQuestion();
        }
    });

    socket.on('next_question', () => nextQuestion());

    socket.on('kick_player', (data) => {
        const targetId = data.playerId;
        if (gameState.players[targetId]) {
            const player = gameState.players[targetId];
            delete gameState.players[targetId];
            io.to(targetId).emit('kicked');
            io.emit('player_list', Object.values(gameState.players));
            // Trigger update for leaderboard if in results screen
            if (gameState.status === 'QUESTION_RESULTS' || gameState.status === 'RESULTS') {
                const leaderboard = Object.values(gameState.players).sort((a, b) => b.score - a.score);
                io.emit('leaderboard_update', { leaderboard });
            }
        }
    });

    socket.on('disconnect', () => {
        const playerId = gameState.socketToPlayer[socket.id];
        if (playerId && gameState.players[playerId]) {
            gameState.players[playerId].connected = false;
            delete gameState.socketToPlayer[socket.id];
            console.log(`Player disconnected: ${gameState.players[playerId].name}`);
            io.emit('player_list', Object.values(gameState.players));
        }
    });
});

let timerInterval;

function nextQuestion() {
    gameState.currentQuestionIndex++;
    if (gameState.currentQuestionIndex >= gameState.questions.length) return showFinalResults();

    gameState.status = 'PLAYING';
    gameState.answersReceived = 0;
    gameState.startTime = Date.now();
    const currentQ = gameState.questions[gameState.currentQuestionIndex];

    io.emit('new_question', {
        index: gameState.currentQuestionIndex,
        total: gameState.questions.length,
        question: currentQ.text,
        image: currentQ.image, // New: question image
        options: currentQ.options,
        optionImages: currentQ.optionImages, // New: option images
        time: currentQ.time,
        type: currentQ.type || 'SINGLE'
    });

    clearInterval(timerInterval);
    let timeLeft = currentQ.time;
    timerInterval = setInterval(() => {
        timeLeft--;
        if (timeLeft <= 0) finishQuestion();
    }, 1000);
}

function getLeaderboard() {
    return Object.values(gameState.players).sort((a, b) => b.score - a.score);
}

function sendResultsToSocket(targetSocket) {
    const currentQ = gameState.questions[gameState.currentQuestionIndex];
    targetSocket.emit('question_finished', {
        correctAnswer: currentQ.correctAnswer,
        correctAnswers: currentQ.correctAnswers,
        correctText: currentQ.correctText,
        type: currentQ.type || 'SINGLE',
        options: currentQ.options,
        leaderboard: getLeaderboard(),
        playerResults: Object.keys(gameState.players).reduce((acc, id) => {
            acc[id] = gameState.players[id].answers[gameState.currentQuestionIndex];
            return acc;
        }, {})
    });
}

function finishQuestion() {
    clearInterval(timerInterval);
    if (gameState.status !== 'PLAYING') return;

    gameState.status = 'QUESTION_RESULTS';
    const currentQ = gameState.questions[gameState.currentQuestionIndex];
    
    io.emit('question_finished', {
        correctAnswer: currentQ.correctAnswer,
        correctAnswers: currentQ.correctAnswers,
        correctText: currentQ.correctText,
        type: currentQ.type || 'SINGLE',
        options: currentQ.options,
        leaderboard: getLeaderboard(),
        playerResults: Object.keys(gameState.players).reduce((acc, id) => {
            acc[id] = gameState.players[id].answers[gameState.currentQuestionIndex];
            return acc;
        }, {})
    });
}

function showFinalResults() {
    gameState.status = 'RESULTS';
    const leaderboard = getLeaderboard();
    saveSessionStats(leaderboard);
    io.emit('final_results', { leaderboard });
}

server.listen(PORT, '127.0.0.1', () => console.log(`Server at ${serverUrl}`));
