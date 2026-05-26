# POST /api/dashboard/auth/login

Authenticate and receive a JWT bearer token.

## Request

- Content-Type: application/json

Body:

```json
{
  "email": "admin",
  "password": "your-password"
}
```

## Response 200

```json
{
  "token": "<jwt>",
  "tokenType": "Bearer",
  "expiresIn": "1d"
}
```

## Errors

- 400: Missing email or password
- 401: Invalid credentials
- 500: Server error
