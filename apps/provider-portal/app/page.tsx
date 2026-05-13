import Link from "next/link";

export default function Home() {
  return (
    <div style={{ maxWidth: 640, margin: "60px auto", padding: 24 }}>
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8 }}>QuroVita — Provider Portal</h1>
      <p style={{ color: "var(--muted)", marginBottom: 24 }}>
        Patient-sovereign health records. Open a session to view a patient&rsquo;s shared bundle.
      </p>
      <Link
        href="/session"
        style={{
          display: "inline-block",
          background: "var(--accent)",
          color: "white",
          padding: "12px 20px",
          borderRadius: 8,
          fontWeight: 600,
          textDecoration: "none",
        }}
      >
        Open Patient Session →
      </Link>
      <p style={{ color: "var(--muted)", fontSize: 13, marginTop: 40 }}>
        v0 demo · backend API at <code>http://localhost:3000</code>
      </p>
    </div>
  );
}
