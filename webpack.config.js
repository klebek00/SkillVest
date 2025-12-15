const path = require('path');
const webpack = require('webpack'); // <-- ДОБАВЛЕНО: импортируем webpack

module.exports = {
  entry: './frontend/app.js',
  output: {
    filename: 'bundle.js',
    path: path.resolve(__dirname, 'frontend'),
  },
  resolve: {
    extensions: ['.ts', '.js'],
    fallback: {
      "buffer": require.resolve("buffer/")
    }
  },
  // --- ДОБАВЛЕН НОВЫЙ РАЗДЕЛ 'plugins' ---
  plugins: [
    new webpack.ProvidePlugin({
      Buffer: ['buffer', 'Buffer'],
    }),
  ],
  // -----------------------------------------
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
    ],
  },
  mode: 'development'
};