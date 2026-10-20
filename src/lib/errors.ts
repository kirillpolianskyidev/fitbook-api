export const ERROR_STATUS = {
  VALIDATION_ERROR: 400,
  RESET_CODE_INVALID: 400,
  RESET_CODE_EXPIRED: 400,
  UNAUTHORIZED: 401,
  TOKEN_EXPIRED: 401,
  INVALID_CREDENTIALS: 401,
  SOCIAL_TOKEN_INVALID: 401,
  FORBIDDEN: 403,
  ONBOARDING_REQUIRED: 403,
  NOT_FOUND: 404,
  EMAIL_TAKEN: 409,
  SLOT_UNAVAILABLE: 409,
  SESSION_FULL: 409,
  ALREADY_BOOKED: 409,
  TRIAL_ALREADY_USED: 409,
  CANCELLATION_WINDOW_PASSED: 409,
  BOOKING_NOT_PAYABLE: 409,
  TRIAL_NOT_ALLOWED: 422,
  PROFILE_INCOMPLETE: 422,
  SESSION_TYPE_INACTIVE: 422,
  RATE_LIMITED: 429,
  TOO_MANY_ATTEMPTS: 429,
  INTERNAL: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  VALIDATION_ERROR: 'Some fields are invalid.',
  RESET_CODE_INVALID: 'The code is incorrect.',
  RESET_CODE_EXPIRED: 'The code has expired. Request a new one.',
  UNAUTHORIZED: 'Authentication required.',
  TOKEN_EXPIRED: 'Access token expired.',
  INVALID_CREDENTIALS: 'Email or password is incorrect.',
  SOCIAL_TOKEN_INVALID: 'Sign-in with this provider failed.',
  FORBIDDEN: 'You do not have access to this resource.',
  ONBOARDING_REQUIRED: 'Complete your profile first.',
  NOT_FOUND: 'Not found.',
  EMAIL_TAKEN: 'An account with this email already exists.',
  SLOT_UNAVAILABLE: 'This time is no longer available.',
  SESSION_FULL: 'This group session is full.',
  ALREADY_BOOKED: 'You have already booked this session.',
  TRIAL_ALREADY_USED: 'The free trial has already been used.',
  CANCELLATION_WINDOW_PASSED: 'It is too late to cancel this training.',
  BOOKING_NOT_PAYABLE: 'This booking cannot be paid.',
  TRIAL_NOT_ALLOWED: 'The free trial is available for individual trainings only.',
  PROFILE_INCOMPLETE: 'Complete the profile before publishing.',
  SESSION_TYPE_INACTIVE: 'This training type is not available.',
  RATE_LIMITED: 'Too many requests. Try again later.',
  TOO_MANY_ATTEMPTS: 'Too many attempts. Request a new code.',
  INTERNAL: 'Something went wrong.',
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message?: string, details?: Record<string, unknown>) {
    super(message ?? ERROR_MESSAGES[code]);
    this.name = 'AppError';
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.details = details;
  }
}

export const isDuplicateKeyError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
