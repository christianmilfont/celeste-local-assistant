import pino from 'pino';
import * as path from 'path';
import { Config } from '../config/Config';

export class Logger {
  private static instance: pino.Logger;

  static getInstance(): pino.Logger {
    if (!Logger.instance) {
      Logger.instance = Logger.create();
    }
    return Logger.instance;
  }

  /**
   * Terminal: apenas LOG_CONSOLE_LEVEL (padrão "warn") para não poluir a interface de voz.
   * Arquivo (LOG_FILE): tudo a partir de LOG_LEVEL.
   */
  private static create(): pino.Logger {
    if (process.env.NODE_ENV === 'test') {
      return pino({ level: 'silent' });
    }

    const consoleLevel = Config.logConsoleLevel;
    const fileLevel = Config.logLevel;
    const minLevel =
      pino.levels.values[consoleLevel] <= pino.levels.values[fileLevel]
        ? consoleLevel
        : fileLevel;

    return pino(
      { level: minLevel },
      pino.transport({
        targets: [
          {
            target: 'pino-pretty',
            level: consoleLevel,
            options: {
              colorize: true,
              translateTime: 'HH:MM:ss',
              ignore: 'pid,hostname',
              destination: 1,
            },
          },
          {
            target: 'pino/file',
            level: fileLevel,
            options: { destination: path.resolve(Config.logFile), mkdir: true },
          },
        ],
      })
    );
  }

  static info(message: string, data?: any): void {
    Logger.getInstance().info(data, message);
  }

  static error(message: string, error?: any): void {
    Logger.getInstance().error(error, message);
  }

  static warn(message: string, data?: any): void {
    Logger.getInstance().warn(data, message);
  }

  static debug(message: string, data?: any): void {
    Logger.getInstance().debug(data, message);
  }
}
