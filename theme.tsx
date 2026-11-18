import * as SecureStore from 'expo-secure-store';
import {
  Appearance, Platform, useColorScheme,
} from 'react-native';
import {
  createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode,
} from 'react';

export type ThemePreference = 'system' | 'light' | 'dark';
export type ColorScheme = Exclude<ThemePreference, 'system'>;

export type AppColors = {
  background: string;
  surface: string;
  surfaceAlt: string;
  text: string;
  muted: string;
  border: string;
  inputBackground: string;
  brand: string;
  brandAccent: string;
  brandText: string;
  brandSoft: string;
  brandSoftText: string;
  onBrandMuted: string;
  danger: string;
  dangerSoft: string;
  subtleButton: string;
  subtleButtonText: string;
  disabledBackground: string;
  disabledText: string;
  progressTrack: string;
  progressFill: string;
  overlay: string;
};

const palettes: Record<ColorScheme, AppColors> = {
  light: {
    background: '#F7F9F6',
    surface: '#FFFFFF',
    surfaceAlt: '#EFF4EF',
    text: '#1C2D20',
    muted: '#5F7064',
    border: '#D9E3DA',
    inputBackground: '#FFFFFF',
    brand: '#07702D',
    brandAccent: '#075D28',
    brandText: '#FFFFFF',
    brandSoft: '#E6F2E8',
    brandSoftText: '#075D28',
    onBrandMuted: '#DDEDDC',
    danger: '#A12A24',
    dangerSoft: '#FCEBE9',
    subtleButton: '#EAF1E9',
    subtleButtonText: '#234D31',
    disabledBackground: '#EDF0EC',
    disabledText: '#718076',
    progressTrack: '#52705A',
    progressFill: '#DCE9AB',
    overlay: 'rgba(0, 0, 0, 0.48)',
  },
  dark: {
    background: '#101812',
    surface: '#19251C',
    surfaceAlt: '#202F23',
    text: '#F0F6F1',
    muted: '#B1BFB4',
    border: '#34463A',
    inputBackground: '#131D16',
    brand: '#07702D',
    brandAccent: '#71D28E',
    brandText: '#FFFFFF',
    brandSoft: '#20392A',
    brandSoftText: '#B8E9C4',
    onBrandMuted: '#D6EEDB',
    danger: '#FF8D83',
    dangerSoft: '#3B211E',
    subtleButton: '#25362A',
    subtleButtonText: '#DCEFE0',
    disabledBackground: '#2A352D',
    disabledText: '#A5B0A7',
    progressTrack: '#48614E',
    progressFill: '#DCE9AB',
    overlay: 'rgba(0, 0, 0, 0.72)',
  },
};

const PREFERENCE_KEY = 'green-fork-theme-preference';

type ThemeContextValue = {
  colors: AppColors;
  scheme: ColorScheme;
  preference: ThemePreference;
  preferenceReady: boolean;
  preferenceSaving: boolean;
  preferenceError: string;
  setPreference: (preference: ThemePreference) => Promise<void>;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function isThemePreference(value: string | null): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark';
}

async function readPreference(): Promise<ThemePreference | null> {
  const value = Platform.OS === 'web'
    ? globalThis.localStorage.getItem(PREFERENCE_KEY)
    : await SecureStore.getItemAsync(PREFERENCE_KEY);
  if (value === null) return null;
  if (!isThemePreference(value)) throw new Error('Stored appearance preference is invalid.');
  return value;
}

async function writePreference(preference: ThemePreference): Promise<void> {
  if (Platform.OS === 'web') {
    globalThis.localStorage.setItem(PREFERENCE_KEY, preference);
    return;
  }
  await SecureStore.setItemAsync(PREFERENCE_KEY, preference);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const systemScheme = useColorScheme();
  const [preference, setPreferenceState] = useState<ThemePreference>('system');
  const [preferenceReady, setPreferenceReady] = useState(false);
  const [preferenceSaving, setPreferenceSaving] = useState(false);
  const [preferenceError, setPreferenceError] = useState('');
  const scheme: ColorScheme = preference === 'system' ? systemScheme ?? 'light' : preference;
  const colors = palettes[scheme];

  useEffect(() => {
    let active = true;
    readPreference()
      .then(saved => { if (active && saved) setPreferenceState(saved); })
      .catch(error => {
        console.error('Unable to load the saved appearance preference.', error);
        if (active) setPreferenceError('We could not load your saved appearance preference.');
      })
      .finally(() => { if (active) setPreferenceReady(true); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'web') Appearance.setColorScheme(preference === 'system' ? 'auto' : preference);
  }, [preference]);

  const setPreference = useCallback(async (nextPreference: ThemePreference) => {
    setPreferenceSaving(true);
    setPreferenceError('');
    try {
      await writePreference(nextPreference);
      setPreferenceState(nextPreference);
    } catch (error) {
      console.error('Unable to save the appearance preference.', error);
      setPreferenceError('We could not save your appearance preference. Your current mode is unchanged.');
    } finally {
      setPreferenceSaving(false);
    }
  }, []);

  const value = useMemo<ThemeContextValue>(() => ({
    colors,
    scheme,
    preference,
    preferenceReady,
    preferenceSaving,
    preferenceError,
    setPreference,
  }), [colors, scheme, preference, preferenceReady, preferenceSaving, preferenceError, setPreference]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useAppTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useAppTheme must be used within a ThemeProvider.');
  return context;
}
