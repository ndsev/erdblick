module.exports = {
    resolve: {
        fallback: {
            "http": require.resolve("stream-http"),
            "https": require.resolve("https-browserify"),
            "zlib": require.resolve("browserify-zlib"),
            "url": require.resolve("url/"),
            "assert": require.resolve("assert/"),
            "stream": require.resolve("stream-browserify"),
            "util": require.resolve("util/")
        }
    },
    module: {
        unknownContextCritical: false
    },
    externals: {
        'cesium': 'Cesium'
    },
};
