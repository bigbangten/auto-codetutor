#include <string.h>

typedef int status_t;

typedef struct
{
    unsigned int valid;
    unsigned int index;
} Demo_ControlType;

static unsigned int s_switchInstance;

status_t Demo_ApplyControl(unsigned int ingressPort)
{
    Demo_ControlType control;
    status_t status;

    memset(&control, 0, sizeof(control));
    control.valid = 1U;
    control.index = ingressPort;
    status = SWITCH_SJA1110_setL2ForwardingTableControl(&control, s_switchInstance);

    return status;
}
