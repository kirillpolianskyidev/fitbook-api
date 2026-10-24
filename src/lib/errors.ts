export const ERROR_STATUS = {
  VALIDATION_ERROR: 400,
  RESET_CODE_INVALID: 400,
  RESET_CODE_EXPIRED: 400,
  VERIFICATION_CODE_INVALID: 400,
  VERIFICATION_CODE_EXPIRED: 400,
  UNAUTHORIZED: 401,
  TOKEN_EXPIRED: 401,
  INVALID_CREDENTIALS: 401,
  SOCIAL_TOKEN_INVALID: 401,
  FORBIDDEN: 403,
  REVIEW_NOT_ALLOWED: 403,
  ONBOARDING_REQUIRED: 403,
  NOT_FOUND: 404,
  EMAIL_TAKEN: 409,
  SLOT_UNAVAILABLE: 409,
  SESSION_FULL: 409,
  ALREADY_BOOKED: 409,
  SESSION_NOT_FULL: 409,
  ALREADY_ON_WAITLIST: 409,
  TRIAL_ALREADY_USED: 409,
  CANCELLATION_WINDOW_PASSED: 409,
  NO_SHOW_WINDOW_PASSED: 409,
  NO_SHOW_NOT_ALLOWED: 409,
  NO_SHOW_REFUNDED: 409,
  REVIEW_EDIT_WINDOW_PASSED: 409,
  RESCHEDULE_WINDOW_PASSED: 409,
  BOOKING_NOT_PAYABLE: 409,
  NO_CREDITS: 409,
  INSUFFICIENT_CREDITS: 409,
  PACKAGE_INACTIVE: 409,
  TRIAL_NOT_ALLOWED: 422,
  PROFILE_INCOMPLETE: 422,
  SESSION_TYPE_INACTIVE: 422,
  RATE_LIMITED: 429,
  TOO_MANY_ATTEMPTS: 429,
  INTERNAL: 500,
  EMAIL_DELIVERY_FAILED: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  VALIDATION_ERROR: 'Some fields are invalid.',
  RESET_CODE_INVALID: 'The code is incorrect.',
  RESET_CODE_EXPIRED: 'The code has expired. Request a new one.',
  VERIFICATION_CODE_INVALID: 'The code is incorrect.',
  VERIFICATION_CODE_EXPIRED: 'The code has expired. Request a new one.',
  UNAUTHORIZED: 'Authentication required.',
  TOKEN_EXPIRED: 'Access token expired.',
  INVALID_CREDENTIALS: 'Email or password is incorrect.',
  SOCIAL_TOKEN_INVALID: 'Sign-in with this provider failed.',
  FORBIDDEN: 'You do not have access to this resource.',
  REVIEW_NOT_ALLOWED: 'You can review a coach after your first completed training.',
  ONBOARDING_REQUIRED: 'Complete your profile first.',
  NOT_FOUND: 'Not found.',
  EMAIL_TAKEN: 'An account with this email already exists.',
  SLOT_UNAVAILABLE: 'This time is no longer available.',
  SESSION_FULL: 'This group session is full.',
  ALREADY_BOOKED: 'You have already booked this session.',
  SESSION_NOT_FULL: 'This session still has places — book it now.',
  ALREADY_ON_WAITLIST: 'You are already on the waitlist.',
  TRIAL_ALREADY_USED: 'The free trial has already been used.',
  CANCELLATION_WINDOW_PASSED: 'It is too late to cancel this training.',
  NO_SHOW_WINDOW_PASSED:
    'A no-show can be marked from the start of the training until 48 hours later.',
  NO_SHOW_NOT_ALLOWED: 'This booking cannot be marked as a no-show.',
  NO_SHOW_REFUNDED: 'The payment was already returned, so the no-show cannot be removed.',
  REVIEW_EDIT_WINDOW_PASSED: 'Reviews can be changed only during 24 hours.',
  RESCHEDULE_WINDOW_PASSED: 'It is too late to reschedule this training.',
  BOOKING_NOT_PAYABLE: 'This booking cannot be paid.',
  NO_CREDITS: 'You have no credits left with this coach.',
  INSUFFICIENT_CREDITS: 'Not enough credits for all dates.',
  PACKAGE_INACTIVE: 'This package is no longer available.',
  TRIAL_NOT_ALLOWED: 'The free trial is available for individual trainings only.',
  PROFILE_INCOMPLETE: 'Complete the profile before publishing.',
  SESSION_TYPE_INACTIVE: 'This training type is not available.',
  RATE_LIMITED: 'Too many requests. Try again later.',
  TOO_MANY_ATTEMPTS: 'Too many attempts. Request a new code.',
  INTERNAL: 'Something went wrong.',
  EMAIL_DELIVERY_FAILED: "We couldn't send the email with your code. Try again in a few minutes.",
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
