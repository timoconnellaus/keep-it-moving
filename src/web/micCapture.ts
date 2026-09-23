/** Gemini Live expects 16 kHz mono PCM, sent in 20–40 ms chunks. */
export const GEMINI_INPUT_RATE = 16_000;
const CHUNK_SECONDS = 0.04;

const WORKLET_SOURCE = `
class PcmCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.size = options.processorOptions.chunkFrames;
    this.buffer = new Float32Array(this.size);
    this.filled = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    let offset = 0;
    while (offset < channel.length) {
      const count = Math.min(channel.length - offset, this.size - this.filled);
      this.buffer.set(channel.subarray(offset, offset + count), this.filled);
      this.filled += count;
      offset += count;
      if (this.filled === this.size) {
        this.port.postMessage(this.buffer, [this.buffer.buffer]);
        this.buffer = new Float32Array(this.size);
        this.filled = 0;
      }
    }
    return true;
  }
}
registerProcessor("pcm-capture", PcmCapture);
`;

/**
 * Converts float samples to 16-bit PCM at the output rate. Downsampling
 * averages each output sample's input span, a box filter that removes most of
 * the aliasing plain sample-picking adds. State carries across chunks.
 */
export class Downsampler {
  private pending = new Float32Array(0);
  private position = 0;
  private readonly ratio: number;

  constructor(inputRate: number, outputRate = GEMINI_INPUT_RATE) {
    this.ratio = inputRate / outputRate;
  }

  push(input: Float32Array): Int16Array {
    const samples = new Float32Array(this.pending.length + input.length);
    samples.set(this.pending);
    samples.set(input, this.pending.length);
    const output: number[] = [];
    let position = this.position;
    while (position + this.ratio <= samples.length) {
      const start = Math.floor(position);
      const end = Math.max(start + 1, Math.floor(position + this.ratio));
      let sum = 0;
      for (let i = start; i < end; i++) sum += samples[i]!;
      output.push(sum / (end - start));
      position += this.ratio;
    }
    const consumed = Math.floor(position);
    this.pending = samples.slice(consumed);
    this.position = position - consumed;
    return toPcm16(output);
  }
}

function toPcm16(samples: ArrayLike<number>): Int16Array {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]!));
    pcm[i] = sample < 0 ? sample * 32768 : sample * 32767;
  }
  return pcm;
}

/** Streams microphone audio as Gemini-ready PCM chunks from an AudioWorklet. */
export class MicCapture {
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;

  constructor(
    private readonly stream: MediaStream,
    private readonly onChunk: (pcm: Int16Array) => void,
  ) {}

  async start(): Promise<void> {
    // A 16 kHz context lets the browser resample with its own filter; some
    // browsers refuse a mic source at a non-native rate, so fall back.
    let context = new AudioContext({ sampleRate: GEMINI_INPUT_RATE });
    let source: MediaStreamAudioSourceNode;
    try {
      source = context.createMediaStreamSource(this.stream);
    } catch {
      await context.close();
      context = new AudioContext();
      source = context.createMediaStreamSource(this.stream);
    }
    this.context = context;
    const url = URL.createObjectURL(
      new Blob([WORKLET_SOURCE], { type: "text/javascript" }),
    );
    try {
      await context.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const downsampler = new Downsampler(context.sampleRate);
    const node = new AudioWorkletNode(context, "pcm-capture", {
      processorOptions: {
        chunkFrames: Math.round(context.sampleRate * CHUNK_SECONDS),
      },
    });
    node.port.onmessage = (event: MessageEvent<Float32Array>) =>
      this.onChunk(downsampler.push(event.data));
    source.connect(node);
    // The node writes no output; the connection keeps it scheduled.
    node.connect(context.destination);
    this.node = node;
  }

  async stop(): Promise<void> {
    if (this.node) this.node.port.onmessage = null;
    this.node?.disconnect();
    this.node = null;
    const context = this.context;
    this.context = null;
    await context?.close().catch(() => undefined);
  }
}
