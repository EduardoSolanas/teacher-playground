import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  readDevicePreference,
  writeDevicePreference,
} from './devicePreferences';

describe('devicePreferences', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('writes and reads a microphone device preference', () => {
    const deviceId = 'mic-device-123';
    writeDevicePreference('microphone', deviceId);
    expect(readDevicePreference('microphone')).toBe(deviceId);
  });

  it('writes and reads a camera device preference', () => {
    const deviceId = 'cam-device-456';
    writeDevicePreference('camera', deviceId);
    expect(readDevicePreference('camera')).toBe(deviceId);
  });

  it('writes and reads a speaker device preference', () => {
    const deviceId = 'spk-device-789';
    writeDevicePreference('speaker', deviceId);
    expect(readDevicePreference('speaker')).toBe(deviceId);
  });

  it('returns undefined when no preference has been set', () => {
    expect(readDevicePreference('microphone')).toBeUndefined();
    expect(readDevicePreference('camera')).toBeUndefined();
    expect(readDevicePreference('speaker')).toBeUndefined();
  });

  it('overwrites a previous preference', () => {
    writeDevicePreference('microphone', 'device-1');
    expect(readDevicePreference('microphone')).toBe('device-1');

    writeDevicePreference('microphone', 'device-2');
    expect(readDevicePreference('microphone')).toBe('device-2');
  });

  it('keeps separate preferences for different device kinds', () => {
    writeDevicePreference('microphone', 'mic-id');
    writeDevicePreference('camera', 'cam-id');
    writeDevicePreference('speaker', 'spk-id');

    expect(readDevicePreference('microphone')).toBe('mic-id');
    expect(readDevicePreference('camera')).toBe('cam-id');
    expect(readDevicePreference('speaker')).toBe('spk-id');
  });

  it('degrades gracefully when localStorage.getItem throws', () => {
    const originalGetItem = localStorage.getItem;
    localStorage.getItem = vi.fn(() => {
      throw new Error('Storage access denied');
    });

    // Should not throw
    const result = readDevicePreference('microphone');
    expect(result).toBeUndefined();

    localStorage.getItem = originalGetItem;
  });

  it('degrades gracefully when localStorage.setItem throws', () => {
    const originalSetItem = localStorage.setItem;
    localStorage.setItem = vi.fn(() => {
      throw new Error('Storage access denied');
    });

    // Should not throw
    expect(() => writeDevicePreference('microphone', 'device-id')).not.toThrow();

    localStorage.setItem = originalSetItem;
  });
});
