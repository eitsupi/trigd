#include <R.h>
#include <Rinternals.h>
#include <R_ext/Rdynload.h>

SEXP C_trigd(SEXP s_width, SEXP s_height, SEXP s_dpi);
SEXP C_trigd_poll_resize(void);

static const R_CallMethodDef CallEntries[] = {
    {"C_trigd",             (DL_FUNC) &C_trigd,             3},
    {"C_trigd_poll_resize", (DL_FUNC) &C_trigd_poll_resize, 0},
    {NULL, NULL, 0}
};

void R_init_trigd(DllInfo *dll) {
    R_registerRoutines(dll, NULL, CallEntries, NULL, NULL);
    R_useDynamicSymbols(dll, FALSE);
    R_forceSymbols(dll, TRUE);
}
