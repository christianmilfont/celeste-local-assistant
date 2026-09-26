import pino from 'pino';
import { Config } from '../config/Config';

export class Logger {
  private static instance: pino.Logger;

  static getInstance(): pino.Logger {
    if (!Logger.instance) {
      Logger.instance = pino({
        level: Config.logLevel,
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss',
            ignore: 'pid,hostname',
          },
        },
      });
    }
    return Logger.instance;
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
