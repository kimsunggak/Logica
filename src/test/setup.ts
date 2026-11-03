// Tests assert English messages; keep them independent of the machine locale.
import { useSettings } from "../settings/settingsStore";

useSettings.getState().updateUI({ language: "en" });
