import { Layer, LayerMap } from "effect"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"

export const noopLocationServiceMap: Layer.Layer<LocationServiceMap.Service, any, any> = 
  (Layer.effect as any)(
    LocationServiceMap.Service,
    (LayerMap.make as any)(
      (_ref: Location.Ref) => Layer.empty,
      { idleTimeToLive: "1 minute" },
    ),
  )
