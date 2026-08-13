#ifndef APP_H
#define APP_H

#include <stdint.h>

typedef union
{
    uint32_t raw;
    struct
    {
        uint16_t command;
        uint16_t checksum;
    } fields;
} App_FrameType;

void App_Init(void);
void App_Run(void);

#endif
