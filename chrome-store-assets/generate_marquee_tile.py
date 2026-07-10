from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "chrome-store-assets" / "marquee-promo-tile-1400x560.png"
ICON_PATH = ROOT / "archive.png"

FONT_REG = "/System/Library/Fonts/Helvetica.ttc"
FONT_BOLD = "/System/Library/Fonts/Supplemental/Arial.ttf"

SIZE = (1400, 560)

BLUE = (43, 102, 255)
CYAN = (27, 184, 255)
NAVY = (22, 34, 84)
TEXT = (26, 33, 54)
MUTED = (101, 116, 150)
PILL = (235, 243, 255)
PILL_TEXT = (37, 98, 255)
CARD = (255, 255, 255)
LINE = (216, 225, 241)


def load_font(size, bold=False):
    return ImageFont.truetype(FONT_BOLD if bold else FONT_REG, size)


def make_gradient(size, start, end):
    width, height = size
    img = Image.new("RGB", size, start)
    pixels = img.load()

    for y in range(height):
        for x in range(width):
            tx = x / max(width - 1, 1)
            ty = y / max(height - 1, 1)
            mix = min(1.0, tx * 0.74 + ty * 0.18)
            pixels[x, y] = tuple(
                int(start[i] * (1 - mix) + end[i] * mix)
                for i in range(3)
            )

    return img


def rounded_mask(size, radius):
    mask = Image.new("L", size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size[0], size[1]), radius=radius, fill=255)
    return mask


def add_glow(base, center, radius, color, alpha):
    overlay = Image.new("RGBA", base.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    x, y = center
    draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=color + (alpha,))
    base.alpha_composite(overlay.filter(ImageFilter.GaussianBlur(radius // 2)))


def paste(base, layer, xy):
    base.alpha_composite(layer.convert("RGBA"), xy)


def draw_card(base, box, radius=34):
    x1, y1, x2, y2 = box

    shadow = Image.new("RGBA", base.size, (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow)
    shadow_draw.rounded_rectangle(
        (x1, y1 + 10, x2, y2 + 10),
        radius=radius,
        fill=(22, 36, 70, 28),
    )
    base.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(20)))

    draw = ImageDraw.Draw(base)
    draw.rounded_rectangle(
        (x1, y1, x2, y2),
        radius=radius,
        fill=CARD + (255,),
        outline=LINE + (255,),
        width=2,
    )


def draw_pill(base, xy, text):
    draw = ImageDraw.Draw(base)
    font = load_font(18, bold=True)
    label = f"✓  {text}"
    width = int(draw.textlength(label, font=font) + 38)
    height = 38
    x, y = xy

    draw.rounded_rectangle((x, y, x + width, y + height), radius=19, fill=PILL + (255,))
    draw.text((x + 16, y + 7), label, font=font, fill=PILL_TEXT + (255,))


def fit_icon(size):
    icon = Image.open(ICON_PATH).convert("RGBA")
    return ImageOps.contain(icon, size, Image.Resampling.LANCZOS)


def draw_brand_icon(base):
    tile = Image.new("RGBA", (116, 116), (0, 0, 0, 0))
    draw = ImageDraw.Draw(tile)
    draw.rounded_rectangle((0, 0, 116, 116), radius=34, fill=BLUE + (255,))
    icon = fit_icon((74, 74))
    paste(tile, icon, ((116 - icon.width) // 2, (116 - icon.height) // 2))
    paste(base, tile, (80, 70))


def draw_3d_plane(base, origin=(700, 310), scale=1.0):
    ox, oy = origin

    def pt(x, y):
        return (int(ox + x * scale), int(oy + y * scale))

    shadow = Image.new("RGBA", base.size, (0, 0, 0, 0))
    sdraw = ImageDraw.Draw(shadow)
    shadow_points = [
        pt(-120, 34),
        pt(-22, 12),
        pt(60, 2),
        pt(160, -24),
        pt(72, 48),
        pt(-34, 86),
    ]
    sdraw.polygon(shadow_points, fill=(24, 44, 96, 50))
    shadow = shadow.filter(ImageFilter.GaussianBlur(18))
    base.alpha_composite(shadow)

    trail = Image.new("RGBA", base.size, (0, 0, 0, 0))
    tdraw = ImageDraw.Draw(trail)
    trail_points = [pt(-180, 110), pt(-150, 78), pt(-112, 56), pt(-82, 42)]
    for index, point in enumerate(trail_points):
      radius = max(4, 14 - index * 3)
      alpha = max(40, 110 - index * 18)
      tdraw.ellipse(
          (point[0] - radius, point[1] - radius, point[0] + radius, point[1] + radius),
          fill=(94, 148, 255, alpha),
      )
    base.alpha_composite(trail.filter(ImageFilter.GaussianBlur(3)))

    plane = Image.new("RGBA", base.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(plane)

    wing_back = [pt(-16, 8), pt(114, -20), pt(32, 56)]
    wing_front = [pt(-76, 60), pt(48, 34), pt(-2, 114)]
    body_top = [pt(-122, 20), pt(56, -16), pt(148, -34), pt(22, 22)]
    body_side = [pt(22, 22), pt(148, -34), pt(112, 10), pt(8, 52), pt(-36, 70)]
    tail_top = [pt(-126, 20), pt(-92, -36), pt(-54, 10)]
    tail_side = [pt(-102, 24), pt(-66, 72), pt(-28, 46), pt(-56, 10)]
    cockpit = [pt(22, 4), pt(70, -10), pt(42, 10), pt(6, 16)]

    draw.polygon(wing_back, fill=(88, 170, 255, 255))
    draw.polygon(wing_front, fill=(48, 118, 255, 255))
    draw.polygon(body_side, fill=(32, 96, 255, 255))
    draw.polygon(body_top, fill=(255, 255, 255, 255))
    draw.polygon(tail_top, fill=(227, 240, 255, 255))
    draw.polygon(tail_side, fill=(62, 126, 255, 255))
    draw.polygon(cockpit, fill=(173, 231, 255, 255))

    outline = ImageDraw.Draw(plane)
    for poly in [wing_back, wing_front, body_top, body_side, tail_top, tail_side]:
        outline.line(poly + [poly[0]], fill=(32, 92, 215, 170), width=max(2, int(scale * 3)))

    nose_glow = Image.new("RGBA", base.size, (0, 0, 0, 0))
    ng = ImageDraw.Draw(nose_glow)
    ng.ellipse((pt(128, -56)[0], pt(128, -56)[1], pt(186, 2)[0], pt(186, 2)[1]), fill=(255, 255, 255, 120))
    plane.alpha_composite(nose_glow.filter(ImageFilter.GaussianBlur(20)))

    base.alpha_composite(plane)


def draw_library_mock(base):
    draw_card(base, (920, 56, 1328, 504), radius=34)

    panel = Image.new("RGBA", (368, 408), (0, 0, 0, 0))
    draw = ImageDraw.Draw(panel)
    draw.rounded_rectangle((0, 0, 368, 408), radius=28, fill=(248, 251, 255, 255))
    draw.text((26, 22), "Downloaded archives", font=load_font(24, bold=True), fill=TEXT + (255,))
    draw.text((26, 58), "Quickly reopen saved files from your library", font=load_font(15), fill=MUTED + (255,))

    titles = [
        "Teleflora_Membership_.webarchive",
        "Edit_Review_.webarchive",
        "FunBlast_Medicine_Organizer_.webarchive",
    ]

    small_icon = fit_icon((18, 18))

    for index, title in enumerate(titles):
        y = 92 + index * 96
        draw.rounded_rectangle((18, y, 350, y + 78), radius=20, fill=(255, 255, 255, 255), outline=LINE + (255,), width=2)
        draw.rounded_rectangle((34, y + 18, 64, y + 48), radius=10, fill=(234, 243, 255, 255))
        panel.alpha_composite(small_icon, (40, y + 24))
        draw.text((78, y + 15), title, font=load_font(16, bold=True), fill=NAVY + (255,))
        draw.text((78, y + 42), "Ready to open", font=load_font(14), fill=(53, 130, 79, 255))
        draw.rounded_rectangle((270, y + 20, 334, y + 56), radius=18, fill=(235, 243, 255, 255))
        draw.text((286, y + 29), "View", font=load_font(14, bold=True), fill=PILL_TEXT + (255,))

    paste(base, panel, (940, 76))


def main():
    base = make_gradient(SIZE, (244, 248, 255), (225, 240, 255)).convert("RGBA")
    add_glow(base, (1170, 70), 220, (111, 176, 255), 52)
    add_glow(base, (630, 305), 140, (97, 161, 255), 48)

    draw_brand_icon(base)

    draw = ImageDraw.Draw(base)
    draw.text((222, 82), "WebArchive Pilot", font=load_font(42, bold=True), fill=TEXT + (255,))
    draw.text((80, 214), "Save webpages as .webarchive files", font=load_font(42, bold=True), fill=NAVY + (255,))
    draw.text((80, 268), "Open them later directly in Chrome", font=load_font(42, bold=True), fill=NAVY + (255,))

    draw_pill(base, (80, 374), "Save current page")
    draw_pill(base, (300, 374), "Archive library")
    draw_pill(base, (494, 374), "Built-in viewer")

    draw_3d_plane(base, origin=(735, 298), scale=1.02)
    draw_library_mock(base)

    OUT.parent.mkdir(exist_ok=True)
    base.convert("RGB").save(OUT)


if __name__ == "__main__":
    main()
