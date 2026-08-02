export type AudioSettings = {
  tapVolume: number;
  errorVolume: number;
  speechVolume: number;
  speakerId: number;
  version: number;
  updatedAt: string;
};

export const defaultAudioSettings: AudioSettings = {
  tapVolume: 100,
  errorVolume: 100,
  speechVolume: 100,
  speakerId: 3,
  version: 0,
  updatedAt: new Date(0).toISOString(),
};

export function audioSettingsStorageKey(registerNumber: number): string {
  return `event-pos-register-${registerNumber}-audio-settings`;
}

export function normalizeAudioSettings(value: Partial<AudioSettings> | null | undefined): AudioSettings {
  const volume = (candidate: unknown, fallback: number) => Number.isInteger(candidate) && Number(candidate) >= 0 && Number(candidate) <= 100 ? Number(candidate) : fallback;
  return {
    tapVolume: volume(value?.tapVolume, defaultAudioSettings.tapVolume),
    errorVolume: volume(value?.errorVolume, defaultAudioSettings.errorVolume),
    speechVolume: volume(value?.speechVolume, defaultAudioSettings.speechVolume),
    speakerId: Number.isInteger(value?.speakerId) && Number(value?.speakerId) > 0 ? Number(value?.speakerId) : defaultAudioSettings.speakerId,
    version: Number.isInteger(value?.version) && Number(value?.version) >= 0 ? Number(value?.version) : 0,
    updatedAt: typeof value?.updatedAt === "string" ? value.updatedAt : defaultAudioSettings.updatedAt,
  };
}

export function loadAudioSettings(registerNumber: number): AudioSettings {
  try { return normalizeAudioSettings(JSON.parse(localStorage.getItem(audioSettingsStorageKey(registerNumber)) ?? "null") as Partial<AudioSettings> | null); }
  catch { return defaultAudioSettings; }
}

export function storeAudioSettings(registerNumber: number, settings: AudioSettings): void {
  localStorage.setItem(audioSettingsStorageKey(registerNumber), JSON.stringify(normalizeAudioSettings(settings)));
}
