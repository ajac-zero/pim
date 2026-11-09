// An error that maps directly to an HTTP status in the API.
export class HttpError extends Error {
	// `extra` is merged into the JSON body, so callers can match on a typed `code`.
	constructor(status, message, extra) {
		super(message)
		this.status = status
		this.extra = extra
	}
}
