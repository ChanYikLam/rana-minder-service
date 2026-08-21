import type { ClockPort } from '../contracts/ports';

export class SystemClock implements ClockPort {
  now(): Date {
    return new Date();
  }
}
