/**
 * FIX 5: infer the AUDIENCE TYPE a Meta/Google ad set targets from its
 * campaign / ad_name / ad_group string. The targeting signal lives in the
 * campaign name (LAL-1pct-music, …-Remarketing, Broad-UAE-25-44); ad_name is
 * usually a creative variant code (video-rp2-22526). So callers should pass the
 * campaign first and fall back to ad_name.
 *
 * Sacred Rule #11: when a name carries no targeting signal, return "unclear" —
 * never invent a targeting type that isn't visible in the data.
 */

export type AudienceType =
  | "lookalike"
  | "broad"
  | "retargeting"
  | "interest"
  | "custom"
  | "creative_only"
  | "unclear";

export type Audience = { type: AudienceType; detail: string };

const INTEREST_TOKENS =
  /\b(music|musicprofessionals|sports?|family|families|parenting|parents|kids|comedy|arabic|desi|bollywood|expats?|russian|filipino|indian|pakistani|nightlife|clubbers?|festival[- _]?goers?)\b/i;

const GEO = /\b(uae|ksa|qatar|qa|bahrain|bh|oman|om|dubai|abudhabi|abu[- _]?dhabi|sharjah|riyadh|jeddah|doha)\b/i;

/** Pull a human-readable trailing descriptor (geo, age, or interest token). */
function detailBits(name: string): string {
  const bits: string[] = [];
  const geo = name.match(GEO);
  if (geo) bits.push(geo[1].toUpperCase().replace(/[-_ ]/g, ""));
  const age = name.match(/\b(\d{2})[- _](\d{2})\b/);
  if (age) bits.push(`${age[1]}-${age[2]}`);
  const interest = name.match(INTEREST_TOKENS);
  if (interest) bits.push(interest[1].toLowerCase());
  return bits.join(" ");
}

export function inferAudienceFromName(name: string): Audience {
  const s = (name || "").toLowerCase();
  if (!s.trim()) return { type: "unclear", detail: "no name" };

  // Lookalike (with percent if present).
  const lal = s.match(/\b(?:lal|lookalike|lla)[- _]?(\d+)\s*(?:pct|%|p)\b/) || s.match(/\blookalike[- _]?(\d+)/);
  if (lal || /\b(?:lal|lookalike|lla)\b/.test(s)) {
    const pct = lal ? `${lal[1]}%` : "";
    const extra = detailBits(s);
    return { type: "lookalike", detail: [pct, extra].filter(Boolean).join(" ") || "unspecified" };
  }

  // Retargeting / remarketing (+ window like 90d / 30d).
  if (/\b(remarket\w*|retarget\w*)\b/.test(s) || /\brt[- _]/.test(s)) {
    const win = s.match(/\b(\d+)\s*d\b/);
    return { type: "retargeting", detail: win ? `${win[1]}d window` : (detailBits(s) || "unspecified window") };
  }
  // A bare NNd window with no other signal also reads as a retargeting window.
  if (/\b\d+\s*d\b/.test(s) && !/\bbroad\b/.test(s)) {
    const win = s.match(/\b(\d+)\s*d\b/);
    return { type: "retargeting", detail: `${win?.[1]}d window` };
  }

  // Custom audience.
  if (/\bcustom[- _]?audience\b/.test(s) || /\bca[- _]/.test(s)) {
    return { type: "custom", detail: detailBits(s) || "custom list" };
  }

  // Interest targeting.
  const interestExplicit = s.match(/\binterest[- _](\w+)/);
  if (interestExplicit) return { type: "interest", detail: interestExplicit[1] };
  if (INTEREST_TOKENS.test(s)) {
    const m = s.match(INTEREST_TOKENS)!;
    return { type: "interest", detail: m[1].toLowerCase() };
  }

  // Broad / demographic.
  if (/\bbroad\b/.test(s) || /\b\d{2}[- _]\d{2}\b/.test(s)) {
    return { type: "broad", detail: detailBits(s) || "broad" };
  }

  // Pure creative variant code (no targeting signal in the name).
  if (/^(video|img|image|carousel|story|reel|ad)[-_ ]?\w*\d*/.test(s) || /\bimage ?ads?\b/.test(s)) {
    return { type: "creative_only", detail: "no targeting signal in name" };
  }

  return { type: "unclear", detail: "no targeting signal in name" };
}

/** Short tag for prompt lines, e.g. "lookalike 1% music" or "creative_only — no targeting signal". */
export function audienceTag(name: string): string {
  const a = inferAudienceFromName(name);
  if (a.type === "creative_only" || a.type === "unclear") return `${a.type} — ${a.detail}`;
  return `${a.type}${a.detail ? " " + a.detail : ""}`;
}
