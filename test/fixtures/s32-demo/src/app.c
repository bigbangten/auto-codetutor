#include "app.h"

#define APP_CHECKSUM_MASK 0x5A5AU

static App_FrameType s_frame;
static uint32_t s_runCount;

static uint16_t App_CalculateChecksum(uint16_t command)
{
    return (uint16_t)(command ^ APP_CHECKSUM_MASK);
}

void App_Init(void)
{
    s_frame.raw = 0U;
    s_runCount = 0U;
}

void App_Run(void)
{
    s_frame.fields.command = (uint16_t)s_runCount;
    s_frame.fields.checksum = App_CalculateChecksum(s_frame.fields.command);
    s_runCount++;
}
