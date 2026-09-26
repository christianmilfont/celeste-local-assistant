import Database from 'better-sqlite3';
import { Config } from '../config/Config';
import { Logger } from '../logging/Logger';
import * as fs from 'fs';
import * as path from 'path';

export class CelesteDatabase {
  private static instance: CelesteDatabase;
  private db: Database.Database;

  private constructor() {
    const dbDir = path.dirname(Config.databasePath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    this.db = new Database(Config.databasePath);
    this.initializeSchema();
  }

  static getInstance(): CelesteDatabase {
    if (!CelesteDatabase.instance) {
      CelesteDatabase.instance = new CelesteDatabase();
    }
    return CelesteDatabase.instance;
  }

  private initializeSchema(): void {
    Logger.info('Initializing database schema');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS contacts (
        id TEXT PRIMARY KEY,
        name TEXT,
        phone_number TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        chat_id TEXT UNIQUE NOT NULL,
        is_group BOOLEAN DEFAULT 0,
        group_name TEXT,
        last_message_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        text TEXT NOT NULL,
        timestamp DATETIME NOT NULL,
        is_from_me BOOLEAN DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id)
      );

      CREATE TABLE IF NOT EXISTS assistant_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        event_data TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_messages_conversation 
        ON messages(conversation_id);
      
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp 
        ON messages(timestamp);
      
      CREATE INDEX IF NOT EXISTS idx_events_timestamp 
        ON assistant_events(timestamp);
    `);

    Logger.info('Database schema initialized successfully');
  }

  getDatabase(): Database.Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }
}
