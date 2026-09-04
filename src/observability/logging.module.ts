import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';

import { pinoHttpOptions } from './pino-options';

/**
 * Configures Pino as the application logger.
 *
 * Re-exports `nestjs-pino`'s `LoggerModule` so the rest of the app imports a
 * single module. Once `main.ts` calls `app.useLogger(app.get(Logger))`, every
 * `new Logger(context)` call and all HTTP request logs route through Pino with
 * the redaction configured in `pino-options.ts`.
 */
@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: pinoHttpOptions,
    }),
  ],
  exports: [LoggerModule],
})
export class ObservabilityModule {}
