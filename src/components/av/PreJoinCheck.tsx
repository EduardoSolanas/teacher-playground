'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent, JSX, MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';

import { useDialogFocusTrap } from '../ConfirmDialog';
import { mapProviderError } from '@/lib/av/avSession';
import type { AvDevice, AvErrorKind } from '@/lib/av/avSession';
import { readDevicePreference, writeDevicePreference } from '@/lib/av/devicePreferences';

/**
 * What the level bar shows for a stretch of microphone samples.
 *
 * Conversational speech sits around 0.05–0.3 RMS while full scale is 1.0, so a
 * plain linear read-out hugs zero for a whole lesson. Doubling the RMS puts a
 * strong voice near full scale and silence at exactly zero, which is the two
 * states this card exists to distinguish. Capped, never negative.
 */
export function micLevelPercent(samples: Float32Array | number[]): number {
  const count = samples.length;
  if (count === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < count; i += 1) {
    sumSquares += samples[i] * samples[i];
  }
  const rms = Math.sqrt(sumSquares / count);
  return Math.min(100, Math.round(rms * 200));
}

type Purpose = 'microphone' | 'camera';

/*
 * Purpose-written copy per failure kind, in the tone of the call panel's
 * errorCopy: say what happened, and always say what still works. A refused
 * device is not a locked door -- the Join button stays available (UX-C4), so
 * every line here ends somewhere survivable.
 */
function failureCopy(purpose: Purpose, kind: AvErrorKind): string {
  const name = purpose === 'microphone' ? 'microphone' : 'camera';
  switch (kind) {
    case 'permission-denied':
      return purpose === 'microphone'
        ? 'Microphone permission was denied. You can still join and listen.'
        : 'Camera permission was denied. You can still join and listen.';
    case 'device-busy':
      return `The ${name} is in use by another app. Close the other app and try again.`;
    case 'device-missing':
      return `No ${name} was found. You can still join without it.`;
    case 'unsupported':
      return `This browser cannot share your ${name}. You can still join and listen.`;
    default:
      return `The ${name} could not be started. You can still join.`;
  }
}

/**
 * What to call a device in the menu.
 *
 * The browser withholds the label until it has a permission to show it by, so
 * a numbered fallback has to stand in -- the same idiom the call panel uses.
 */
function deviceLabel(device: AvDevice, index: number, kind: 'Microphone' | 'Camera'): string {
  return device.label.trim() || `${kind} ${index + 1}`;
}

/*
 * A controlled <select> whose value matches no <option> renders blank instead
 * of showing the placeholder, so a stored id whose device has since vanished
 * falls back to the Default option rather than an empty-looking row.
 */
function selectedDeviceValue(devices: readonly AvDevice[], selectedId: string): string {
  if (!selectedId) return '';
  return devices.some((device) => device.deviceId === selectedId) ? selectedId : '';
}

/*
 * Icons, inline SVG only -- DESIGN.md §8: no emoji as UI icons. currentColor
 * strokes so the surrounding text colour drives them, aria-hidden because each
 * sits inside a control or line that already carries a name.
 */
function IconMicrophone({ className }: { readonly className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 3a3 3 0 013 3v6a3 3 0 01-6 0V6a3 3 0 013-3z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 11a7 7 0 0014 0M12 18v3" />
    </svg>
  );
}

function IconCamera({ className }: { readonly className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 6.5h12v11H3v-11zM15 10.5l6-3.5v10l-6-3.5" />
    </svg>
  );
}

export function PreJoinCheck(props: {
  onConfirm: () => void; // user pressed "Join call"
  onCancel: () => void; // user pressed Cancel / Escape / backdrop
}): JSX.Element | null {
  const { onConfirm, onCancel } = props;

  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioStreamRef = useRef<MediaStream | null>(null);
  const videoStreamRef = useRef<MediaStream | null>(null);

  // Portalling needs a document, which server rendering has not got.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const [devices, setDevices] = useState<{ microphone: AvDevice[]; camera: AvDevice[] }>({
    microphone: [],
    camera: [],
  });
  const [micId, setMicId] = useState('');
  const [camId, setCamId] = useState('');
  const [audioReady, setAudioReady] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  /*
   * Streams live in refs; the version bumps whenever the camera stream is
   * replaced, so the srcObject effect re-runs even though videoReady was
   * already true -- a picker change must move the picture, not just the state.
   */
  const [videoVersion, setVideoVersion] = useState(0);
  const [audioError, setAudioError] = useState<{ kind: AvErrorKind } | null>(null);
  const [videoError, setVideoError] = useState<{ kind: AvErrorKind } | null>(null);
  const [micLevel, setMicLevel] = useState(0);

  const stopAll = useCallback(() => {
    audioStreamRef.current?.getTracks().forEach((track) => track.stop());
    audioStreamRef.current = null;
    videoStreamRef.current?.getTracks().forEach((track) => track.stop());
    videoStreamRef.current = null;
  }, []);

  const startAudio = useCallback(
    async (deviceId: string | undefined) => {
      audioStreamRef.current?.getTracks().forEach((track) => track.stop());
      audioStreamRef.current = null;
      setAudioReady(false);
      const media = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
      if (!media) {
        setAudioError({ kind: 'unsupported' });
        return;
      }
      try {
        // Audio only: the camera must not be touched from this call.
        const stream = await media({ audio: deviceId ? { deviceId } : true, video: false });
        audioStreamRef.current = stream;
        setAudioError(null);
        setAudioReady(true);
      } catch (err) {
        setAudioError(mapProviderError(err));
      }
    },
    [],
  );

  const startVideo = useCallback(
    async (deviceId: string | undefined) => {
      videoStreamRef.current?.getTracks().forEach((track) => track.stop());
      videoStreamRef.current = null;
      setVideoReady(false);
      const media = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
      if (!media) {
        setVideoError({ kind: 'unsupported' });
        return;
      }
      try {
        // Video only: a refusal here leaves the audio half untouched.
        const stream = await media({ audio: false, video: deviceId ? { deviceId } : true });
        videoStreamRef.current = stream;
        setVideoError(null);
        setVideoVersion((version) => version + 1);
        setVideoReady(true);
      } catch (err) {
        setVideoError(mapProviderError(err));
      }
    },
    [],
  );

  // On mount: read the stored preferences, then audio first, then video, as
  // two separate getUserMedia calls so one refusal cannot kill the other.
  // Devices are enumerated last: browsers only hand over labels once a
  // permission to show them by has been granted.
  useEffect(() => {
    let cancelled = false;
    const storedMic = readDevicePreference('microphone');
    const storedCam = readDevicePreference('camera');
    setMicId(storedMic ?? '');
    setCamId(storedCam ?? '');
    void (async () => {
      await startAudio(storedMic ?? undefined);
      if (cancelled) return;
      await startVideo(storedCam ?? undefined);
      if (cancelled) return;
      try {
        const all = await navigator.mediaDevices.enumerateDevices();
        if (cancelled) return;
        setDevices({
          microphone: all
            .filter((info) => info.kind === 'audioinput')
            .map((info) => ({ deviceId: info.deviceId, label: info.label })),
          camera: all
            .filter((info) => info.kind === 'videoinput')
            .map((info) => ({ deviceId: info.deviceId, label: info.label })),
        });
      } catch {
        // No list is survivable: the browser defaults still work.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [startAudio, startVideo]);

  // Every exit path -- unmount, Join, Cancel, Escape, backdrop -- lands here,
  // so no preview track can outlive the card.
  useEffect(() => () => stopAll(), [stopAll]);

  // Feed the preview element whenever a new camera stream exists.
  useEffect(() => {
    if (!videoReady) return;
    const video = videoRef.current;
    const stream = videoStreamRef.current;
    if (!video || !stream) return;
    video.srcObject = stream;
  }, [videoReady, videoVersion]);

  /*
   * Mic meter: an AnalyserNode sampled on a short interval, driving the bar by
   * width only -- no keyframed pulse, and the house reduce-motion rule in
   * globals.css flattens the width transition too. An interval rather than
   * requestAnimationFrame because a coarse level bar does not need per-frame
   * updates and keeps working where rAF is absent.
   */
  useEffect(() => {
    if (!audioReady) return;
    const stream = audioStreamRef.current;
    const Ctor = typeof window !== 'undefined' ? window.AudioContext : undefined;
    if (!stream || typeof Ctor !== 'function') return;
    let context: AudioContext;
    try {
      context = new Ctor();
    } catch {
      return;
    }
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    // The source reaches the analyser only: the mic is never played back out
    // loud, which would feed the room's speakers straight into the room's mic.
    source.connect(analyser);
    const buffer = new Float32Array(analyser.fftSize);
    const sample = () => {
      analyser.getFloatTimeDomainData(buffer);
      setMicLevel(micLevelPercent(buffer));
    };
    sample();
    const timer = window.setInterval(sample, 120);
    return () => {
      window.clearInterval(timer);
      void context.close().catch(() => undefined);
    };
  }, [audioReady]);

  const handleConfirm = useCallback(() => {
    stopAll();
    onConfirm();
  }, [onConfirm, stopAll]);

  const handleCancel = useCallback(() => {
    stopAll();
    onCancel();
  }, [onCancel, stopAll]);

  // On the document, not the dialog: focus sitting on the body after a click
  // on non-focusable card text must still let Escape work.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        handleCancel();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [handleCancel]);

  // Named dialog per the ConfirmDialog pattern: focus starts inside (on Join,
  // the action the person came here for), Tab is contained, and whatever held
  // focus before the card gets it back on close.
  useDialogFocusTrap(dialogRef, confirmRef);

  const handleBackdropClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (event.target === event.currentTarget) {
        handleCancel();
      }
    },
    [handleCancel],
  );

  const handleMicChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const deviceId = event.target.value;
    setMicId(deviceId);
    if (deviceId) writeDevicePreference('microphone', deviceId);
    void startAudio(deviceId || undefined);
  };

  const handleCamChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const deviceId = event.target.value;
    setCamId(deviceId);
    if (deviceId) writeDevicePreference('camera', deviceId);
    void startVideo(deviceId || undefined);
  };

  const readinessLine = audioReady && videoReady
    ? 'Camera and microphone are ready.'
    : audioReady
      ? 'Microphone is ready.'
      : videoReady
        ? 'Camera is ready.'
        : audioError || videoError
          ? 'No camera or microphone is available. You can still join.'
          : 'Asking the browser for your camera and microphone...';

  if (!mounted) return null;

  return createPortal(
    <div
      data-testid="av-pre-join"
      onClick={handleBackdropClick}
      /*
       * z-[1600]: the modal layer of DESIGN.md §7, above every piece of room
       * chrome. On a phone this is a bottom sheet -- thumbs live there -- and
       * from sm up a centred card; max-h on the 100dvh viewport keeps either
       * form inside the screen, and the sheet clears the home-indicator inset.
       */
      className="fixed inset-0 z-[1600] flex items-end justify-center bg-black/60 sm:items-center sm:p-4"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="av-pre-join-title"
        className="flex max-h-[100dvh] w-full flex-col overflow-y-auto rounded-t-2xl border border-slate-700/70 bg-slate-900/95 text-slate-200 shadow-2xl shadow-slate-950/60 backdrop-blur-xl sm:max-w-md sm:rounded-2xl"
      >
        <div className="p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:p-6">
          <h2 id="av-pre-join-title" className="m-0 mb-3 text-base font-semibold text-white">
            Check your camera and microphone
          </h2>

          <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-slate-700/60 bg-slate-950/80">
            <video
              ref={videoRef}
              data-testid="av-pre-join-video"
              autoPlay
              muted
              playsInline
              // Self-view is mirrored, the same convention as the call tiles.
              className="h-full w-full -scale-x-100 object-cover"
            />
            {!videoReady && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-xs text-slate-400">
                <IconCamera className="h-6 w-6" />
                <span>{videoError ? 'Camera preview unavailable' : 'Starting the camera...'}</span>
              </div>
            )}
          </div>

          <div className="mt-2.5 flex items-center gap-2">
            <IconMicrophone className="h-4 w-4 shrink-0 text-slate-400" />
            <div
              data-testid="av-pre-join-mic-level"
              className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-800"
            >
              <div
                className="h-full rounded-full bg-[var(--blue)] transition-[width] duration-150"
                style={{ width: `${micLevel}%` }}
              />
            </div>
          </div>

          {(audioError || videoError) && (
            <div className="mt-2.5 flex flex-col gap-1.5">
              {audioError && (
                <div role="alert" data-testid="av-pre-join-audio-alert" className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs leading-relaxed text-amber-200">
                  <IconMicrophone className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                  <span className="min-w-0 flex-1">{failureCopy('microphone', audioError.kind)}</span>
                </div>
              )}
              {videoError && (
                <div role="alert" data-testid="av-pre-join-video-alert" className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs leading-relaxed text-amber-200">
                  <IconCamera className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                  <span className="min-w-0 flex-1">{failureCopy('camera', videoError.kind)}</span>
                </div>
              )}
            </div>
          )}

          <p role="status" data-testid="av-pre-join-status" className="mb-0 mt-2.5 text-xs text-slate-400">
            {readinessLine}
          </p>

          {(devices.microphone.length > 0 || devices.camera.length > 0) && (
            <div className="mt-3 flex flex-col gap-2">
              {devices.microphone.length > 0 && (
                <label className="flex items-center gap-2 text-xs text-slate-300">
                  <span className="w-14 shrink-0 text-[0.6875rem] font-semibold uppercase tracking-wider text-slate-400">Mic</span>
                  <select
                    data-testid="av-pre-join-mic"
                    className="min-h-11 min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-800/90 px-2.5 text-xs text-slate-200 transition-colors duration-150 hover:border-slate-600 sm:min-h-0 sm:py-1"
                    onChange={handleMicChange}
                    value={selectedDeviceValue(devices.microphone, micId)}
                  >
                    <option value="">Default microphone</option>
                    {devices.microphone.map((device, index) => (
                      <option key={device.deviceId} value={device.deviceId}>
                        {deviceLabel(device, index, 'Microphone')}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {devices.camera.length > 0 && (
                <label className="flex items-center gap-2 text-xs text-slate-300">
                  <span className="w-14 shrink-0 text-[0.6875rem] font-semibold uppercase tracking-wider text-slate-400">Cam</span>
                  <select
                    data-testid="av-pre-join-cam"
                    className="min-h-11 min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-800/90 px-2.5 text-xs text-slate-200 transition-colors duration-150 hover:border-slate-600 sm:min-h-0 sm:py-1"
                    onChange={handleCamChange}
                    value={selectedDeviceValue(devices.camera, camId)}
                  >
                    <option value="">Default camera</option>
                    {devices.camera.map((device, index) => (
                      <option key={device.deviceId} value={device.deviceId}>
                        {deviceLabel(device, index, 'Camera')}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          )}

          <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              data-testid="av-pre-join-cancel"
              onClick={handleCancel}
              className="min-h-11 rounded-lg border border-slate-600 bg-transparent px-5 text-sm font-semibold text-slate-300 transition-colors duration-150 hover:bg-slate-800 hover:text-white"
            >
              Cancel
            </button>
            <button
              ref={confirmRef}
              type="button"
              data-testid="av-pre-join-confirm"
              onClick={handleConfirm}
              // Always available: a soft failure is never a locked door.
              className="min-h-11 rounded-lg border-none bg-[var(--blue)] px-5 text-sm font-semibold text-white transition-colors duration-150 hover:brightness-110"
            >
              Join call
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
