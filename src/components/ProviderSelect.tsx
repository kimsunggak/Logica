import { PROVIDER_LABELS } from "../ai/providers/registry";
import { PROVIDER_IDS, type ProviderId } from "../ai/types";
import { isConnected, isKnown, useConnections } from "../settings/connectionStore";
import { useT } from "../i18n";
import { useSettings } from "../settings/settingsStore";

interface ProviderSelectProps {
  value: ProviderId;
  onChange: (provider: ProviderId) => void;
  title?: string;
  className?: string;
}

/** Provider dropdown; disconnected providers are marked. */
export function ProviderSelect({ value, onChange, title, className }: ProviderSelectProps) {
  const t = useT();
  const connections = useConnections();
  const openaiAuth = useSettings((s) => s.ai.openaiAuth);
  return (
    <select
      className={`select ${className ?? ""}`}
      value={value}
      title={title ?? t("provider.title")}
      onChange={(e) => onChange(e.target.value as ProviderId)}
    >
      {PROVIDER_IDS.map((id) => (
        <option key={id} value={id}>
          {PROVIDER_LABELS[id]}
          {isKnown(connections[id]) && !isConnected(id, connections[id], openaiAuth) ? ` ${t("provider.notConnected")}` : ""}
        </option>
      ))}
    </select>
  );
}
