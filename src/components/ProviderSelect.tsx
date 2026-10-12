import { PROVIDER_LABELS } from "../ai/providers/registry";
import { PROVIDER_IDS, type ProviderId } from "../ai/types";
import { isConnected, useConnections } from "../settings/connectionStore";

interface ProviderSelectProps {
  value: ProviderId;
  onChange: (provider: ProviderId) => void;
  title?: string;
  className?: string;
}

/** Provider dropdown; disconnected providers are marked. */
export function ProviderSelect({ value, onChange, title, className }: ProviderSelectProps) {
  const connections = useConnections();
  return (
    <select
      className={`select ${className ?? ""}`}
      value={value}
      title={title ?? "AI provider"}
      onChange={(e) => onChange(e.target.value as ProviderId)}
    >
      {PROVIDER_IDS.map((id) => (
        <option key={id} value={id}>
          {PROVIDER_LABELS[id]}
          {connections[id].status && !isConnected(connections[id]) ? " (not connected)" : ""}
        </option>
      ))}
    </select>
  );
}
