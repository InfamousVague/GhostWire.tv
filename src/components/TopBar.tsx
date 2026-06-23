import { useEffect, useState } from "react";
import { Icon } from "@mattmattmattmatt/base/primitives/icon/Icon";
import { Spinner } from "@mattmattmattmatt/base/primitives/spinner/Spinner";
import { IN_TAURI } from "../ipc/engine";
import { vpnStatus, type VpnStatus } from "../ipc/library";
import { chevronLeft, chevronRight, circleCheck, panelLeftClose, panelLeftOpen, shieldCheck, shieldOff, triangleAlert } from "../lib/icons";
import { IS_IOS } from "../lib/platform";
import TipPopover from "./TipPopover";

interface OrganizeChip {
  phase: string;
  done: number;
  total: number;
  moved: number;
  changes: number;
}

interface TopBarProps {
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  /** While collapsed, hovering the toggle peeks the sidebar in a flyout (Claude-style). */
  onToggleHoverEnter?: () => void;
  onToggleHoverLeave?: () => void;
  /** Live organize-task status, or null when idle. */
  organize?: OrganizeChip | null;
  onOrganizeClick?: () => void;
  /** Browser-style history navigation. */
  onBack?: () => void;
  onForward?: () => void;
  canGoBack?: boolean;
  canGoForward?: boolean;
}

export function TopBar({ sidebarCollapsed, onToggleSidebar, onToggleHoverEnter, onToggleHoverLeave, organize, onOrganizeClick, onBack, onForward, canGoBack, canGoForward }: TopBarProps) {
  const [vpn, setVpn] = useState<VpnStatus | null>(null);

  useEffect(() => {
    if (IS_IOS || !IN_TAURI) return;
    let alive = true;
    const tick = () => {
      if (document.hidden) return; // skip the IPC poll while the app is in the background
      vpnStatus().then((v) => alive && setVpn(v)).catch(() => {});
    };
    tick();
    const h = window.setInterval(tick, 10000);
    return () => {
      alive = false;
      window.clearInterval(h);
    };
  }, []);

  return (
    <div className="topbar" data-tauri-drag-region>
      {/* Reserves the macOS traffic-light overlay zone (titleBarStyle: Overlay). */}
      <div className="topbar-gutter" data-tauri-drag-region />
      {/* On iOS the topbar is just an empty safe-area strip under the system status
          bar — no sidebar toggle (the nav rail is always visible) and no chrome. */}
      {!IS_IOS && (
        <button
          type="button"
          className="topbar-toggle"
          onClick={onToggleSidebar}
          onMouseEnter={sidebarCollapsed ? onToggleHoverEnter : undefined}
          onMouseLeave={sidebarCollapsed ? onToggleHoverLeave : undefined}
          aria-pressed={sidebarCollapsed}
          aria-label={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
          title={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
        >
          <Icon icon={sidebarCollapsed ? panelLeftOpen : panelLeftClose} size="xl" />
        </button>
      )}
      {!IS_IOS && (
        <div className="topbar-nav">
          <button
            type="button"
            className="topbar-navbtn"
            onClick={onBack}
            disabled={!canGoBack}
            aria-label="Back"
            title="Back"
          >
            <Icon icon={chevronLeft} size="xl" />
          </button>
          <button
            type="button"
            className="topbar-navbtn"
            onClick={onForward}
            disabled={!canGoForward}
            aria-label="Forward"
            title="Forward"
          >
            <Icon icon={chevronRight} size="xl" />
          </button>
        </div>
      )}
      <div className="spacer" data-tauri-drag-region />
      {!IS_IOS && organize && (
        <button className={`org-chip org-chip--${organize.phase}`} onClick={onOrganizeClick} title="Organize library">
          {organize.phase === "organizing" ? (
            <>
              <Spinner size="xs" />
              Organizing {organize.done}/{organize.total}
            </>
          ) : organize.phase === "done" ? (
            <><Icon icon={circleCheck} size="sm" /> Organized {organize.moved}</>
          ) : (
            <><Icon icon={triangleAlert} size="sm" /> Organize failed</>
          )}
        </button>
      )}
      {!IS_IOS && vpn && (
        <span
          className={`vpn-chip ${vpn.active ? "on" : "off"}`}
          title={vpn.interface ? `Default route via ${vpn.interface}` : "No VPN tunnel detected"}
        >
          <Icon icon={vpn.active ? shieldCheck : shieldOff} size="sm" />
          {vpn.active ? "VPN on" : "No VPN"}
        </span>
      )}
      {/* Support tip jar — same heart-pill deck widget as libre.academy's nav,
          restyled (.topbar-tip) to match the VPN / organize status chips. Desktop-only. */}
      {!IS_IOS && <TipPopover label="Support" className="topbar-tip" />}
    </div>
  );
}
