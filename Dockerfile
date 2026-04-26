# Build stage
FROM golang:1.26-alpine AS builder

WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -trimpath -o miraishi .

# Final stage
FROM alpine:latest
RUN apk add --no-cache coturn
WORKDIR /app

COPY --from=builder /app/miraishi /app/config.json /app/entrypoint.sh ./
COPY --from=builder /app/static ./static
COPY --from=builder /app/translations ./translations
COPY --from=builder /app/turnserver.conf /etc/coturn/turnserver.conf

RUN chmod +x ./entrypoint.sh

# Go app port
EXPOSE 8080
# Coturn ports
EXPOSE 3478 3478/udp
EXPOSE 50000-51000/udp

CMD ["./entrypoint.sh"]
