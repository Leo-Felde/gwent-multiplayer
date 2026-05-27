// you will need to install dot env for this to work
// const ADDRESS = process.env.ADDRESS ?? 'localhost';
// const PORT = process.env.PORT ?? 8080;

const WS_HOST = 'localhost';
const WS_PORT = 8080;

// For network access change to
// const WS_HOST = '0.0.0.0';
// const WS_PORT = 8080;

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { WS_HOST, WS_PORT };
}