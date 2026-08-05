export type LivespaceErrorCode =
  | "AUTH_FAILED"
  | "PERMISSION_DENIED"
  | "NOT_LOGGED_IN"
  | "VALIDATION_ERROR"
  | "BAD_PARAMS"
  | "UNKNOWN_MODULE"
  | "UNKNOWN_METHOD"
  | "UPSTREAM_ERROR"
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "CANCELLED"
  | "RATE_LIMITED"
  | "WRITE_OUTCOME_UNKNOWN";

export class LivespaceError extends Error {
  constructor(
    readonly code: LivespaceErrorCode,
    message: string,
    readonly hint: string,
    readonly resultCode?: number,
  ) {
    super(message);
    this.name = "LivespaceError";
  }
}

interface MappedError {
  code: LivespaceErrorCode;
  message: string;
  hint: string;
}

const RESULT_CODE_MAP: Record<number, MappedError> = {
  400: {
    code: "UPSTREAM_ERROR",
    message: "Livespace reported a general method error (400).",
    hint: "Check the call parameters and retry once.",
  },
  420: {
    code: "VALIDATION_ERROR",
    message: "Livespace rejected the request as invalid (420).",
    hint: "One or more field values are invalid for this method. Fix them and retry.",
  },
  500: {
    code: "UPSTREAM_ERROR",
    message: "Livespace reported a general API error (500).",
    hint: "Retry once; if it persists, reduce the request size.",
  },
  514: {
    code: "UNKNOWN_MODULE",
    message: "Unknown API module (514).",
    hint: "Server bug: the module name is wrong. Report it on the issue tracker.",
  },
  515: {
    code: "UNKNOWN_METHOD",
    message: "Unknown API method (515).",
    hint: "Server bug: the method name is wrong. Report it on the issue tracker.",
  },
  516: {
    code: "UPSTREAM_ERROR",
    message: "Unsupported output format (516).",
    hint: "Server bug in URL construction. Report it on the issue tracker.",
  },
  520: {
    code: "UPSTREAM_ERROR",
    message: "Livespace database error (520).",
    hint: "Retry with backoff; if it persists, the Livespace instance may be having issues.",
  },
  530: {
    code: "NOT_LOGGED_IN",
    message: "The API session is not authenticated (530).",
    hint: "The per-request auth token was rejected. This is usually transient - retry the call.",
  },
  540: {
    code: "PERMISSION_DENIED",
    message: "The API key's user lacks permission for this record or action (540).",
    hint:
      "This is a Livespace permission issue, not a call error. Use a record the key's " +
      "user can access, or adjust permissions in Livespace.",
  },
  550: {
    code: "BAD_PARAMS",
    message: "Livespace rejected the call parameters (550).",
    hint: "Check required parameters - e.g. Deal/getAll requires at least one condition.",
  },
  560: {
    code: "AUTH_FAILED",
    message: "Invalid auth method (560).",
    hint: "Server bug in the auth flow. Report it on the issue tracker.",
  },
  561: {
    code: "AUTH_FAILED",
    message: "Invalid auth parameters (561).",
    hint: "Verify LIVESPACE_API_KEY and LIVESPACE_API_SECRET.",
  },
  562: {
    code: "AUTH_FAILED",
    message: "Invalid API key (562).",
    hint: "Verify LIVESPACE_API_KEY (Livespace: Account settings -> API).",
  },
  563: {
    code: "AUTH_FAILED",
    message: "Authorization failed (563).",
    hint: "Verify the key/secret pair and that API access is enabled for this user.",
  },
  564: {
    code: "AUTH_FAILED",
    message: "General authorization error (564).",
    hint: "Verify credentials; if they are correct, retry later.",
  },
};

export function errorFromEnvelope(resultCode: number): LivespaceError {
  const mapped = RESULT_CODE_MAP[resultCode];
  if (mapped) {
    return new LivespaceError(mapped.code, mapped.message, mapped.hint, resultCode);
  }
  return new LivespaceError(
    "UPSTREAM_ERROR",
    `Livespace returned unexpected result code ${resultCode}.`,
    "Retry once; report the code on the issue tracker if it persists.",
    resultCode,
  );
}
