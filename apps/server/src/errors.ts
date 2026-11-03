export type ErrorCode = 'validation' | 'not_found' | 'version_conflict' | 'conflict' | 'unauthorized' | 'internal';

const statusByCode: Record<ErrorCode, number> = {
  validation: 400,
  not_found: 404,
  version_conflict: 409,
  conflict: 409,
  unauthorized: 401,
  internal: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly current?: unknown;

  constructor(code: ErrorCode, message: string, options: { current?: unknown; status?: number } = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = options.status ?? statusByCode[code];
    this.current = options.current;
  }
}

export const validationError = (message: string) => new AppError('validation', message);
export const notFound = (label: string) => new AppError('not_found', `${label} was not found.`);
export const conflict = (message: string) => new AppError('conflict', message);
