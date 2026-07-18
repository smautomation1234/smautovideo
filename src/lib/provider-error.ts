export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "ProviderHttpError";
  }

  get retryable() {
    return this.status === 429 || this.status >= 500;
  }
}

export type ProviderErrorCategory =
  | "policy"
  | "quota"
  | "permission"
  | "temporary_provider"
  | "network"
  | "invalid_request"
  | "unknown";

export interface ClassifiedProviderError {
  category: ProviderErrorCategory;
  code: string | null;
  supportCodes: string[];
  retryable: boolean;
  technicalMessage: string;
  userMessage: string;
}

const POLICY_SUPPORT_CODES = new Set([
  "58061214",
  "17301594",
  "29310472",
  "15236754",
  "64151117",
  "42237218",
  "62263041",
  "57734940",
  "22137204",
  "74803281",
  "29578790",
  "42876398",
  "89371032",
  "49114662",
  "63429089",
  "72817394",
  "60599140",
  "35561574",
  "35561575",
  "90789179",
  "43188360",
  "78610348",
  "61493863",
  "56562880",
  "32635315",
]);

export function classifyProviderError(error: unknown): ClassifiedProviderError {
  const technicalMessage =
    error instanceof Error ? error.message : String(error || "Unknown provider error.");
  const normalized = technicalMessage.toLowerCase();
  const supportCodes = Array.from(
    new Set(technicalMessage.match(/\b\d{8}\b/g) || [])
  );
  const httpStatus = error instanceof ProviderHttpError ? error.status : null;

  if (
    supportCodes.some((code) => POLICY_SUPPORT_CODES.has(code)) ||
    [
      "might violate our policies",
      "prompt couldn't be submitted",
      "prompt could not be submitted",
      "safety filter",
      "safety violation",
      "usage guidelines",
      "prohibited content",
      "responsible ai",
    ].some((phrase) => normalized.includes(phrase))
  ) {
    return {
      category: "policy",
      code: "GOOGLE_POLICY",
      supportCodes,
      retryable: false,
      technicalMessage,
      userMessage:
        "This prompt could not be generated because it may conflict with Google’s video policy. Update the prompt and generate a new take.",
    };
  }

  if (httpStatus === 429 || normalized.includes("resource_exhausted") || normalized.includes("quota")) {
    return {
      category: "quota",
      code: httpStatus ? `HTTP_${httpStatus}` : "GOOGLE_QUOTA",
      supportCodes,
      retryable: true,
      technicalMessage,
      userMessage:
        "Google is currently busy or the generation quota was reached. ReelForge will retry automatically.",
    };
  }

  if (
    httpStatus === 401 ||
    httpStatus === 403 ||
    normalized.includes("permission_denied") ||
    normalized.includes("unauthenticated")
  ) {
    return {
      category: "permission",
      code: httpStatus ? `HTTP_${httpStatus}` : "GOOGLE_PERMISSION",
      supportCodes,
      retryable: false,
      technicalMessage,
      userMessage:
        "Google Cloud rejected the project credentials or permissions. Check the service account configuration.",
    };
  }

  if (
    httpStatus !== null &&
    (httpStatus >= 500 || httpStatus === 408 || httpStatus === 504)
  ) {
    return {
      category: "temporary_provider",
      code: `HTTP_${httpStatus}`,
      supportCodes,
      retryable: true,
      technicalMessage,
      userMessage:
        "Google’s generation service is temporarily unavailable. ReelForge will retry automatically.",
    };
  }

  if (
    normalized.includes("connection ended") ||
    normalized.includes("could not connect") ||
    normalized.includes("network") ||
    normalized.includes("fetch failed")
  ) {
    return {
      category: "network",
      code: "NETWORK",
      supportCodes,
      retryable: false,
      technicalMessage,
      userMessage:
        "The connection ended before ReelForge could confirm the result. Review the job before retrying to avoid duplicate charges.",
    };
  }

  if (httpStatus === 400 || normalized.includes("invalid_argument")) {
    return {
      category: "invalid_request",
      code: httpStatus ? `HTTP_${httpStatus}` : "INVALID_REQUEST",
      supportCodes,
      retryable: false,
      technicalMessage,
      userMessage:
        "Google could not process this generation request. Review the prompt and source media, then generate a new take.",
    };
  }

  return {
    category: "unknown",
    code: httpStatus ? `HTTP_${httpStatus}` : null,
    supportCodes,
    retryable: error instanceof ProviderHttpError && error.retryable,
    technicalMessage,
    userMessage: "Video generation failed. Review the details below before retrying.",
  };
}
