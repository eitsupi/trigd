# Registered .Call entries (suppress R CMD check NOTEs)
#' @useDynLib trigd, .registration = TRUE
NULL

.onLoad = function(libname, pkgname) {
  op = options()
  defaults = list(trigd.socket = NULL)
  toset = !(names(defaults) %in% names(op))
  if (any(toset)) options(defaults[toset])
  invisible()
}
