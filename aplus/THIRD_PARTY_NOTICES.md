# Avisos de terceros

Esta aplicación utiliza o descarga los siguientes componentes de terceros.

## JSZip 3.10.1

- Proyecto: https://stuk.github.io/jszip/
- Repositorio: https://github.com/Stuk/jszip
- Licencia: MIT o GPLv3, a elección del usuario.
- Uso en esta aplicación: generación del ZIP en el navegador.
- Distribución: se incluye `vendor/jszip.min.js`.
- Texto de licencia: `vendor/JSZIP-LICENSE.markdown`.

## Transformers.js 4.2.0

- Proyecto: https://github.com/huggingface/transformers.js
- Paquete: `@huggingface/transformers`
- Licencia: Apache License 2.0.
- Uso en esta aplicación: tokenización, preprocesado de imagen, ejecución ONNX y cálculo de embeddings CLIP.
- Distribución: se importa en tiempo de ejecución desde jsDelivr; no está incluido físicamente en este archivo ZIP.

Copyright de Transformers.js y sus colaboradores según los avisos del proyecto. El uso está sujeto a la Apache License 2.0:
https://www.apache.org/licenses/LICENSE-2.0

## Xenova/clip-vit-base-patch32

- Modelo ONNX: https://huggingface.co/Xenova/clip-vit-base-patch32
- Modelo original: https://huggingface.co/openai/clip-vit-base-patch32
- Implementación original: https://github.com/openai/CLIP
- Licencia declarada del modelo original: MIT.
- Uso en esta aplicación: clasificación visual zero-shot mediante embeddings de texto e imagen.
- Distribución: los pesos no están incluidos en el ZIP; el navegador los descarga desde Hugging Face en la primera ejecución.

Copyright (c) 2021 OpenAI. El texto de la licencia MIT del proyecto original está disponible en:
https://github.com/openai/CLIP/blob/main/LICENSE

## ONNX Runtime Web

Transformers.js descarga y utiliza ONNX Runtime Web como motor de inferencia. Sus avisos y condiciones se encuentran en:

- https://onnxruntime.ai/
- https://github.com/microsoft/onnxruntime

ONNX Runtime se distribuye bajo licencia MIT, de acuerdo con su repositorio oficial.

## Servicios de distribución

- jsDelivr distribuye el módulo JavaScript de Transformers.js.
- Hugging Face Hub y su infraestructura de archivos distribuyen el modelo.

El despliegue de esta aplicación debe respetar las condiciones de uso y políticas vigentes de esos servicios.
