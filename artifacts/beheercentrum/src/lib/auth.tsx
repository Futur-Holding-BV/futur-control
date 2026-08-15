import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

type AuthState = "loading" | "authenticated" | "anonymous";

interface AuthContextValue {
  state: AuthState;
  login: (password: string) => Promise<string | null>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>("loading");

  useEffect(() => {
    fetch("/api/auth/me")
      .then((res) => setState(res.ok ? "authenticated" : "anonymous"))
      .catch(() => setState("anonymous"));
  }, []);

  const login = async (password: string): Promise<string | null> => {
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        setState("authenticated");
        return null;
      }
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return body?.error ?? "Inloggen is niet gelukt. Probeer het opnieuw.";
    } catch {
      return "De server is niet bereikbaar. Probeer het zo opnieuw.";
    }
  };

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    setState("anonymous");
  };

  return <AuthContext.Provider value={{ state, login, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
