function errorHandler(error, req, res, next) {
  console.error('SERVER ERROR:', error)

  res.status(500).json({
    success: false,
    error: 'Internal server error',
  })
}

module.exports = { errorHandler }