import { useState } from "react";
import { sendPushTest } from "@workspace/api-client-react";
import {
  Loader2,
  Smartphone,
  BellRing,
  Share,
  PlusSquare,
  CheckCircle2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { usePush, isIos, isStandalone } from "@/hooks/use-push";

/**
 * "Meldingen op dit apparaat" — enable/disable web push for the installed
 * PWA, with install instructions for iPhone (where push requires the app to
 * be on the home screen) and Android.
 */
export function PushSettingsCard() {
  const { support, enabled, busy, error, denied, enable, disable } = usePush();
  const [testState, setTestState] = useState<"idle" | "sending" | "sent" | "failed">("idle");

  const sendTest = async () => {
    setTestState("sending");
    try {
      await sendPushTest();
      setTestState("sent");
    } catch {
      setTestState("failed");
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card p-5 flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <div
          className={cn(
            "mt-0.5 p-2 rounded-lg",
            enabled ? "bg-emerald-500/10 text-emerald-500" : "bg-muted text-muted-foreground",
          )}
        >
          <Smartphone className="h-5 w-5" />
        </div>
        <div className="flex-1">
          <p className="font-medium text-sm">Meldingen op dit apparaat</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Pushmeldingen volgen dezelfde regels als Slack: pas na 10 minuten
            aanhoudend probleem, en niet tijdens het stiltevenster.
          </p>
        </div>
      </div>

      {support === "needs-install" && (
        <div className="rounded-lg bg-muted/50 border border-border/50 p-4 text-sm space-y-2">
          <p className="font-medium">Installeer de app eerst op je beginscherm</p>
          <p className="text-xs text-muted-foreground">
            Op iPhone werken pushmeldingen alleen vanuit de geïnstalleerde app
            (iOS 16.4 of nieuwer):
          </p>
          <ol className="list-decimal list-inside space-y-1.5 text-muted-foreground text-xs leading-relaxed">
            <li className="flex items-center gap-1.5">
              <span>1. Tik in Safari op</span>
              <Share className="h-3.5 w-3.5 inline" />
              <span><strong>Deel</strong></span>
            </li>
            <li className="flex items-center gap-1.5">
              <span>2. Kies</span>
              <PlusSquare className="h-3.5 w-3.5 inline" />
              <span><strong>Zet op beginscherm</strong></span>
            </li>
            <li>3. Open de app vanaf het beginscherm en zet meldingen hier aan</li>
          </ol>
        </div>
      )}

      {support === "unsupported" && (
        <p className="text-xs text-amber-500">
          Deze browser ondersteunt geen pushmeldingen. Gebruik Chrome (Android)
          of installeer de app op het beginscherm (iPhone, iOS 16.4+).
        </p>
      )}

      {support === "supported" && (
        <div className="flex flex-col gap-2">
          {isIos() && !isStandalone() && (
            <p className="text-xs text-muted-foreground">
              Tip: op iPhone werken meldingen alleen betrouwbaar vanuit de app
              op het beginscherm.
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {enabled ? (
              <>
                <button
                  onClick={disable}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50"
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <BellRing className="h-4 w-4" />}
                  Meldingen uitzetten
                </button>
                <button
                  onClick={sendTest}
                  disabled={testState === "sending"}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50"
                >
                  {testState === "sending" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <BellRing className="h-4 w-4" />
                  )}
                  Testmelding
                </button>
                {testState === "sent" && (
                  <span className="inline-flex items-center gap-1 text-xs text-emerald-500">
                    <CheckCircle2 className="h-3.5 w-3.5" /> Verstuurd
                  </span>
                )}
                {testState === "failed" && (
                  <span className="text-xs text-amber-500">Testmelding mislukt</span>
                )}
              </>
            ) : (
              <button
                onClick={enable}
                disabled={busy || denied}
                className="inline-flex items-center gap-1.5 rounded-lg bg-primary text-primary-foreground px-3 py-2 text-sm hover:opacity-90 disabled:opacity-50"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <BellRing className="h-4 w-4" />}
                Meldingen aanzetten op dit apparaat
              </button>
            )}
          </div>

          {enabled && (
            <p className="inline-flex items-center gap-1.5 text-xs text-emerald-500">
              <CheckCircle2 className="h-3.5 w-3.5" /> Dit apparaat ontvangt pushmeldingen
            </p>
          )}
          {denied && !enabled && (
            <p className="text-xs text-amber-500">
              Meldingen zijn geblokkeerd voor deze site. Zet ze aan in de
              browser- of systeeminstellingen en herlaad de pagina.
            </p>
          )}
          {error && <p className="text-xs text-amber-500">{error}</p>}
        </div>
      )}
    </div>
  );
}
