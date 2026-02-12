#' JSON Graphics Device
#'
#' Opens a graphics device that streams plot operations as JSON to an external
#' renderer (e.g. a browser client) over a Unix domain socket.
#'
#' @param width Device width in inches (default 8).
#' @param height Device height in inches (default 6).
#' @param dpi Resolution in dots per inch (default 96).
#' @return Invisible `NULL`. The device is opened as a side effect.
#' @export
trigd = function(width = 8, height = 6, dpi = 96) {
  .Call(C_trigd, as.double(width), as.double(height), as.double(dpi))
  invisible()
}
