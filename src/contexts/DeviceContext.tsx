import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { IN_TAURI } from "../ipc/engine";
import { getSetting, setSetting } from "../ipc/library";
import { setActiveDevice, type LinkedDevice } from "../ipc/remote";

// App-wide "linked Mac" state. When set (on the iPad), downloads can be pushed to the Mac
// and content streamed from it. Persisted in the settings table (Tauri) / localStorage (web).

interface DeviceContextValue {
  linkedMac: LinkedDevice | null;
  link: (device: LinkedDevice) => Promise<void>;
  unlink: () => Promise<void>;
}

const KEY = "linked_device";
const DeviceContext = createContext<DeviceContextValue>({
  linkedMac: null,
  link: async () => {},
  unlink: async () => {},
});

export function DeviceProvider({ children }: { children: ReactNode }) {
  const [linkedMac, setLinkedMac] = useState<LinkedDevice | null>(null);

  // Keep the module-level holder in sync so the plain ipc/* functions (no React context)
  // can route reads/playback to the linked Mac in companion mode.
  useEffect(() => {
    setActiveDevice(linkedMac);
  }, [linkedMac]);

  useEffect(() => {
    const parse = (s: string | null | undefined) => {
      if (!s) return;
      try {
        setLinkedMac(JSON.parse(s) as LinkedDevice);
      } catch {
        /* ignore corrupt value */
      }
    };
    if (IN_TAURI) {
      getSetting(KEY).then(parse).catch(() => {});
    } else {
      try {
        parse(localStorage.getItem(KEY));
      } catch {
        /* ignore */
      }
    }
  }, []);

  async function persist(value: string) {
    if (IN_TAURI) await setSetting(KEY, value).catch(() => {});
    else {
      try {
        if (value) localStorage.setItem(KEY, value);
        else localStorage.removeItem(KEY);
      } catch {
        /* ignore */
      }
    }
  }

  const link = async (device: LinkedDevice) => {
    setLinkedMac(device);
    await persist(JSON.stringify(device));
  };
  const unlink = async () => {
    setLinkedMac(null);
    await persist("");
  };

  return <DeviceContext.Provider value={{ linkedMac, link, unlink }}>{children}</DeviceContext.Provider>;
}

export function useLinkedDevice() {
  return useContext(DeviceContext);
}
