// Testes nunca tocam o banco real, hardware de áudio ou serviços externos.
process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = ':memory:';
process.env.AUDIO_TEMP_DIR = require('path').join(require('os').tmpdir(), 'celeste-tests');
process.env.KEEP_AUDIO_FILES = 'false';
process.env.AI_REWRITE_REPLIES = 'true';
