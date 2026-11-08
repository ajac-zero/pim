// An error that maps directly to an HTTP status in the API.
export class HttpError extends Error {
	constructor(status, message) {
		super(message)
		this.status = status
	}
}
