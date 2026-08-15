import { useState, type FormEvent } from "react";
import { ShieldCheck, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/lib/auth";

export default function LoginPage() {
  const { login } = useAuth();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const message = await login(password);
    if (message) {
      setError(message);
      setBusy(false);
    }
  };

  return (
    <div className="min-h-[100dvh] flex items-center justify-center bg-background text-foreground px-4">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-8 flex flex-col gap-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary border border-primary/20">
            <ShieldCheck className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">FPS-Beheercentrum</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Log in met het beheerderswachtwoord.
            </p>
          </div>
        </div>
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <Input
            type="password"
            autoFocus
            autoComplete="current-password"
            placeholder="Wachtwoord"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" disabled={busy || password.length === 0}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Inloggen"}
          </Button>
        </form>
      </div>
    </div>
  );
}
