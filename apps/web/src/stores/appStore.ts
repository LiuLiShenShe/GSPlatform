import { create } from 'zustand';

interface AppState {
  apiBaseUrl: string;
  setApiBaseUrl: (url: string) => void;
  isReady: boolean;
  setReady: (ready: boolean) => void;
}

export const useAppStore = create<AppState>((set) => ({
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8001',
  setApiBaseUrl: (url) => set({ apiBaseUrl: url }),
  isReady: false,
  setReady: (ready) => set({ isReady: ready }),
}));
