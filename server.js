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
const io = new Server(server);
const upload = multer({ dest: 'uploads/' });

const PORT = process.env.PORT || 3000;

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
    players: {}, 
    answersReceived: 0,
    startTime: null,
    quizTitle: 'Квиз',
    pin: null
};

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

const localIp = getLocalIp();
const serverUrl = `http://${localIp}:${PORT}`;

// API Routes
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/api/server-info', (req, res) => {
    QRCode.toDataURL(serverUrl, (err, url) => {
        res.json({ url: serverUrl, qr: url, pin: gameState.pin });
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
        return res.json({ path: `/quizzes/${req.params.quizId}/${req.file.filename}` });
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
        return res.json({ path: `/quizzes/${quizId}/${filename}` });
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
    socket.on('validate_pin', (data) => {
        if (gameState.pin && data.pin === gameState.pin && gameState.status === 'LOBBY') {
            socket.emit('pin_valid');
        } else {
            socket.emit('pin_invalid', { message: !gameState.pin ? 'Квиз еще не запущен' : 'Неверный PIN' });
        }
    });

    socket.on('join', (data) => {
        if (gameState.status !== 'LOBBY') return socket.emit('error', 'Game started');
        gameState.players[socket.id] = {
            id: socket.id,
            name: data.name,
            emoji: data.emoji,
            score: 0,
            answers: {}
        };
        io.emit('player_list', Object.values(gameState.players));
        socket.emit('joined', { status: gameState.status });
    });

    socket.on('start_quiz', () => {
        if (gameState.questions.length === 0) return;
        nextQuestion();
    });

    socket.on('submit_answer', (data) => {
        const player = gameState.players[socket.id];
        if (!player || gameState.status !== 'PLAYING') return;

        const currentQ = gameState.questions[gameState.currentQuestionIndex];
        let isCorrect = false;

        if (currentQ.type === 'SINGLE' || !currentQ.type) {
            isCorrect = data.answerIndex === currentQ.correctAnswer;
        } else if (currentQ.type === 'MULTI') {
            const studentAnswers = (data.answerIndices || []).sort().join(',');
            const correctAnswers = (currentQ.correctAnswers || []).sort().join(',');
            isCorrect = studentAnswers === correctAnswers && studentAnswers !== '';
        } else if (currentQ.type === 'TEXT') {
            const studentText = (data.answerText || '').trim().toLowerCase();
            const correctText = (currentQ.correctText || '').trim().toLowerCase();
            isCorrect = studentText === correctText;
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
        io.emit('player_answered', { playerId: socket.id, count: gameState.answersReceived });

        if (gameState.answersReceived >= Object.keys(gameState.players).length) {
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
        if (gameState.players[socket.id]) {
            delete gameState.players[socket.id];
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

function finishQuestion() {
    clearInterval(timerInterval);
    if (gameState.status !== 'PLAYING') return;

    gameState.status = 'QUESTION_RESULTS';
    const currentQ = gameState.questions[gameState.currentQuestionIndex];
    const leaderboard = Object.values(gameState.players).sort((a, b) => b.score - a.score);

    io.emit('question_finished', {
        correctAnswer: currentQ.correctAnswer,
        leaderboard,
        playerResults: Object.keys(gameState.players).reduce((acc, id) => {
            acc[id] = gameState.players[id].answers[gameState.currentQuestionIndex];
            return acc;
        }, {})
    });
}

function showFinalResults() {
    gameState.status = 'RESULTS';
    const leaderboard = Object.values(gameState.players).sort((a, b) => b.score - a.score);
    saveSessionStats(leaderboard);
    io.emit('final_results', { leaderboard });
}

server.listen(PORT, () => console.log(`Server at ${serverUrl}`));
