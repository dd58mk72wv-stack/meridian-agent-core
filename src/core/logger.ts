import pino from 'pino';

const isProduction = process.env.NODE_ENV === 'production';

export const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  ...(isProduction
    ? {}
    : { transport: { target: 'pino-pretty', options: { colorize: true } } }),
  redact: {
    // Client systems handle patient and customer records. A log line is the
    // easiest place for one to escape to somewhere it is retained.
    paths: [
      'apiKey', 'api_key', 'token', 'password', 'secret',
      '*.apiKey', '*.api_key', '*.token', '*.password', '*.secret',
      'headers.authorization', 'headers.cookie',
      'patient', 'dob', 'date_of_birth', 'nhs_number', 'medical',
      '*.patient', '*.dob', '*.date_of_birth', '*.nhs_number', '*.medical',
    ],
    censor: '[redacted]',
  },
});
