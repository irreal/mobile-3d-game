FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/server .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/server /server
# Signalling (HTTP, behind the TLS proxy) and the WebRTC UDP port.
EXPOSE 8080 47100/udp
USER nonroot
HEALTHCHECK --interval=30s --timeout=3s CMD ["/server", "healthcheck"]
ENTRYPOINT ["/server"]
