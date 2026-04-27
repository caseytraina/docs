#!/usr/bin/env python3

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Place a screenshot on top of a background image with rounded corners "
            "and a soft drop shadow."
        )
    )
    parser.add_argument(
        "--screenshot",
        required=True,
        type=Path,
        help="Path to the source screenshot.",
    )
    parser.add_argument(
        "--background",
        default=Path("assets/beta-homepage-background.png"),
        type=Path,
        help="Path to the background image.",
    )
    parser.add_argument(
        "--output",
        required=True,
        type=Path,
        help="Path for the generated image.",
    )
    parser.add_argument(
        "--max-width-ratio",
        default=0.9,
        type=float,
        help="Maximum screenshot width as a fraction of the background width.",
    )
    parser.add_argument(
        "--max-height-ratio",
        default=0.9,
        type=float,
        help="Maximum screenshot height as a fraction of the background height.",
    )
    parser.add_argument(
        "--corner-radius",
        default=32,
        type=int,
        help="Rounded corner radius for the screenshot card in pixels.",
    )
    parser.add_argument(
        "--shadow-blur",
        default=22,
        type=int,
        help="Blur radius for the shadow in pixels.",
    )
    parser.add_argument(
        "--shadow-offset-y",
        default=12,
        type=int,
        help="Vertical shadow offset in pixels.",
    )
    parser.add_argument(
        "--shadow-opacity",
        default=110,
        type=int,
        help="Shadow opacity from 0 to 255.",
    )
    return parser.parse_args()


def rounded_mask(size: tuple[int, int], radius: int) -> Image.Image:
    mask = Image.new("L", size, 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((0, 0, size[0], size[1]), radius=radius, fill=255)
    return mask


def main() -> None:
    args = parse_args()

    background = Image.open(args.background).convert("RGBA")
    screenshot = Image.open(args.screenshot).convert("RGBA")

    max_width = int(background.width * args.max_width_ratio)
    max_height = int(background.height * args.max_height_ratio)
    scale = min(max_width / screenshot.width, max_height / screenshot.height)
    resized_width = max(1, round(screenshot.width * scale))
    resized_height = max(1, round(screenshot.height * scale))
    screenshot = screenshot.resize(
        (resized_width, resized_height), Image.Resampling.LANCZOS
    )

    x = (background.width - screenshot.width) // 2
    y = (background.height - screenshot.height) // 2

    mask = rounded_mask(screenshot.size, args.corner_radius)

    shadow_mask = Image.new("L", background.size, 0)
    shadow_draw = ImageDraw.Draw(shadow_mask)
    shadow_draw.rounded_rectangle(
        (
            x,
            y + args.shadow_offset_y,
            x + screenshot.width,
            y + args.shadow_offset_y + screenshot.height,
        ),
        radius=args.corner_radius,
        fill=args.shadow_opacity,
    )
    shadow_mask = shadow_mask.filter(ImageFilter.GaussianBlur(args.shadow_blur))

    shadow_layer = Image.new("RGBA", background.size, (0, 0, 0, 0))
    shadow_layer.putalpha(shadow_mask)

    framed = background.copy()
    framed.alpha_composite(shadow_layer)
    framed.paste(screenshot, (x, y), mask)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    framed.save(args.output)


if __name__ == "__main__":
    main()
