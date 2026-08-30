from PIL import Image, ImageDraw

def create_rounded_mask(size, radius):
    mask = Image.new('L', size, 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((0, 0, size[0], size[1]), radius=radius, fill=255)
    return mask

try:
    # Open the image
    img = Image.open('frontend/icon.jpg').convert('RGBA')

    # The image is likely 1024x1024
    width, height = img.size

    # Estimated bounds for the central 3D icon
    left = int(width * 0.15)
    top = int(height * 0.15)
    right = int(width * 0.85)
    bottom = int(height * 0.85)

    # Crop the image
    cropped = img.crop((left, top, right, bottom))
    c_width, c_height = cropped.size

    # Create a rounded mask
    mask = create_rounded_mask(cropped.size, radius=int(c_width * 0.22))

    # Apply mask
    cropped.putalpha(mask)

    # Save
    cropped.save('frontend/icon.png')
    print("Successfully masked and saved to frontend/icon.png")
except Exception as e:
    print(f"Error: {e}")
