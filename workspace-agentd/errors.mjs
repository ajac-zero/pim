// An error that maps to a JSON error response.
export class HttpError extends Error {
	constructor(status, code, message) {
		super(message)
		this.status = status
		this.code = code
	}
}
