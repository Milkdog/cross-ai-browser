#!/usr/bin/env node
/**
 * Generate custom notification sounds for Cross AI Browser.
 * Produces 3 .aiff files in assets/sounds/:
 *   - crossai-chime.aiff  — Two-note ascending chime (C5→E5), ~0.4s
 *   - crossai-bell.aiff   — Single bell tone with decay (G5), ~0.3s
 *   - crossai-pulse.aiff  — Quick double-tap pulse (A4, A4), ~0.3s
 *
 * Run once: node scripts/generate-sounds.js
 */

const fs = require('fs');
const path = require('path');

const SAMPLE_RATE = 44100;
const BIT_DEPTH = 16;
const NUM_CHANNELS = 1;

/**
 * Write a buffer of 16-bit PCM samples as an AIFF file.
 */
function writeAIFF(filePath, samples) {
  const numFrames = samples.length;
  const bytesPerSample = BIT_DEPTH / 8;
  const soundDataSize = numFrames * NUM_CHANNELS * bytesPerSample;
  // SSND chunk: 8 bytes header + 8 bytes (offset + blockSize) + sound data
  const ssndChunkSize = 8 + soundDataSize;
  // COMM chunk size is always 18
  const commChunkSize = 18;
  // FORM size = 4 (AIFF) + 8+commChunkSize + 8+ssndChunkSize
  const formSize = 4 + (8 + commChunkSize) + (8 + ssndChunkSize);

  const buf = Buffer.alloc(12 + 8 + commChunkSize + 8 + ssndChunkSize);
  let offset = 0;

  // FORM header
  buf.write('FORM', offset); offset += 4;
  buf.writeUInt32BE(formSize, offset); offset += 4;
  buf.write('AIFF', offset); offset += 4;

  // COMM chunk
  buf.write('COMM', offset); offset += 4;
  buf.writeUInt32BE(commChunkSize, offset); offset += 4;
  buf.writeInt16BE(NUM_CHANNELS, offset); offset += 2;
  buf.writeUInt32BE(numFrames, offset); offset += 4;
  buf.writeInt16BE(BIT_DEPTH, offset); offset += 2;
  // Sample rate as 80-bit extended float
  const extFloat = encodeIEEE754Extended(SAMPLE_RATE);
  extFloat.copy(buf, offset); offset += 10;

  // SSND chunk
  buf.write('SSND', offset); offset += 4;
  buf.writeUInt32BE(ssndChunkSize, offset); offset += 4;
  buf.writeUInt32BE(0, offset); offset += 4; // offset
  buf.writeUInt32BE(0, offset); offset += 4; // blockSize

  // PCM data
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    const intVal = Math.round(clamped * 32767);
    buf.writeInt16BE(intVal, offset); offset += 2;
  }

  fs.writeFileSync(filePath, buf);
  console.log(`  Created: ${path.basename(filePath)} (${(buf.length / 1024).toFixed(1)} KB, ${(numFrames / SAMPLE_RATE).toFixed(2)}s)`);
}

/**
 * Encode a number as 80-bit IEEE 754 extended precision.
 */
function encodeIEEE754Extended(value) {
  const buf = Buffer.alloc(10);
  if (value === 0) return buf;

  let sign = 0;
  if (value < 0) { sign = 1; value = -value; }

  let exponent = Math.floor(Math.log2(value));
  let mantissa = value / Math.pow(2, exponent);

  // Bias for 80-bit extended is 16383
  const biasedExp = exponent + 16383;

  buf.writeUInt16BE((sign << 15) | (biasedExp & 0x7FFF), 0);

  // Mantissa: 64-bit integer (with explicit integer bit)
  let mantissaInt = BigInt(Math.round(mantissa * Math.pow(2, 63)));
  buf.writeUInt32BE(Number((mantissaInt >> 32n) & 0xFFFFFFFFn), 2);
  buf.writeUInt32BE(Number(mantissaInt & 0xFFFFFFFFn), 6);

  return buf;
}

/**
 * Generate a sine wave at a given frequency.
 */
function sine(freq, t) {
  return Math.sin(2 * Math.PI * freq * t);
}

/**
 * Exponential decay envelope.
 */
function decay(t, duration, rate = 5) {
  return Math.exp(-rate * t / duration);
}

// --- Sound Generators ---

/**
 * crossai-chime: Two-note ascending chime (C5→E5), ~0.4s
 * A pleasant two-note chime with harmonic overtones.
 */
function generateChime() {
  const duration = 0.4;
  const numSamples = Math.floor(SAMPLE_RATE * duration);
  const samples = new Float64Array(numSamples);

  const noteC5 = 523.25; // C5
  const noteE5 = 659.25; // E5
  const splitPoint = 0.18; // first note duration

  for (let i = 0; i < numSamples; i++) {
    const t = i / SAMPLE_RATE;
    let sample = 0;

    if (t < splitPoint) {
      // First note: C5 with harmonics
      const env = decay(t, splitPoint, 4);
      sample = (
        0.6 * sine(noteC5, t) +
        0.25 * sine(noteC5 * 2, t) +
        0.1 * sine(noteC5 * 3, t)
      ) * env;
    } else {
      // Second note: E5 with harmonics
      const t2 = t - splitPoint;
      const env = decay(t2, duration - splitPoint, 4);
      sample = (
        0.6 * sine(noteE5, t2) +
        0.25 * sine(noteE5 * 2, t2) +
        0.1 * sine(noteE5 * 3, t2)
      ) * env;
    }

    samples[i] = sample * 0.7; // master volume
  }

  return samples;
}

/**
 * crossai-bell: Single bell tone with decay (G5), ~0.3s
 * Rich bell timbre with inharmonic overtones.
 */
function generateBell() {
  const duration = 0.3;
  const numSamples = Math.floor(SAMPLE_RATE * duration);
  const samples = new Float64Array(numSamples);

  const fundamental = 783.99; // G5

  for (let i = 0; i < numSamples; i++) {
    const t = i / SAMPLE_RATE;
    const env = decay(t, duration, 6);

    // Bell-like inharmonic partials
    const sample = (
      0.5 * sine(fundamental, t) * decay(t, duration, 5) +
      0.3 * sine(fundamental * 2.76, t) * decay(t, duration, 7) +
      0.15 * sine(fundamental * 5.4, t) * decay(t, duration, 10) +
      0.08 * sine(fundamental * 8.93, t) * decay(t, duration, 14)
    );

    samples[i] = sample * 0.7;
  }

  return samples;
}

/**
 * crossai-pulse: Quick double-tap pulse (A4, A4), ~0.3s
 * Two short identical taps with a brief gap.
 */
function generatePulse() {
  const duration = 0.3;
  const numSamples = Math.floor(SAMPLE_RATE * duration);
  const samples = new Float64Array(numSamples);

  const freq = 440; // A4
  const tapDuration = 0.08;
  const gapStart = 0.09;
  const tap2Start = 0.15;

  for (let i = 0; i < numSamples; i++) {
    const t = i / SAMPLE_RATE;
    let sample = 0;

    if (t < tapDuration) {
      // First tap
      const env = decay(t, tapDuration, 8);
      sample = (
        0.6 * sine(freq, t) +
        0.3 * sine(freq * 2, t) +
        0.1 * sine(freq * 3, t)
      ) * env;
    } else if (t >= tap2Start && t < tap2Start + tapDuration) {
      // Second tap
      const t2 = t - tap2Start;
      const env = decay(t2, tapDuration, 8);
      sample = (
        0.6 * sine(freq, t2) +
        0.3 * sine(freq * 2, t2) +
        0.1 * sine(freq * 3, t2)
      ) * env;
    }

    samples[i] = sample * 0.7;
  }

  return samples;
}

// --- Main ---

const outDir = path.join(__dirname, '..', 'assets', 'sounds');
fs.mkdirSync(outDir, { recursive: true });

console.log('Generating notification sounds...');
writeAIFF(path.join(outDir, 'crossai-chime.aiff'), Array.from(generateChime()));
writeAIFF(path.join(outDir, 'crossai-bell.aiff'), Array.from(generateBell()));
writeAIFF(path.join(outDir, 'crossai-pulse.aiff'), Array.from(generatePulse()));
console.log('Done!');
